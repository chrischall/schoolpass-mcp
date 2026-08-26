/**
 * Authenticated SchoolPass API client.
 *
 * Owns the whole session lifecycle for a parent account:
 *
 *  - **Deferred config.** The constructor never reads credentials, so the server
 *    boots without them; {@link SchoolPassClient.ensureSession} resolves config
 *    (throwing {@link SchoolPassConfigError}) on the first authenticated call.
 *  - **Single-flight bootstrap.** Concurrent first calls share one `login()`.
 *  - **Token lifecycle via `TokenManager`.** Proactive refresh inside the skew
 *    window; a reactive 401 refreshes once and replays once. If the refresh
 *    token itself is dead, the client falls back to a full re-login rather than
 *    surfacing an opaque error.
 *  - **One `AppCode` header on every call**, plus `Authorization: Bearer`.
 *
 * SchoolPass uses real HTTP status codes, so the client asserts `res.ok` and
 * throws {@link SchoolPassApiError} otherwise — a 403 (parent hitting an
 * admin route) carries an actionable hint.
 */

import { TokenManager } from '@chrischall/mcp-utils/session';
import { buildQueryString } from '@chrischall/mcp-utils';
import { login, refreshToken as refreshTokens, type SchoolPassIdentity } from './auth.js';
import { resolveConfig, type SchoolPassConfig } from './config.js';
import {
  ENDPOINTS,
  SchoolPassApiError,
  apiBaseUrl,
  buildHeaders,
  sendRequest,
  type FetchLike,
} from './protocol.js';
import {
  createSessionCache,
  tokenView,
  reportCacheWriteFailure,
} from './session-cache.js';

/** Query params: strings, numbers, booleans, or arrays thereof; `undefined` dropped. */
export type QueryParams = Record<
  string,
  string | number | boolean | undefined | (string | number)[]
>;

export interface SchoolPassClientOptions {
  /** Injectable fetch (tests). */
  fetchImpl?: FetchLike;
  /** Injectable env (tests). */
  env?: NodeJS.ProcessEnv;
}

export class SchoolPassClient {
  private readonly fetchImpl?: FetchLike;
  private readonly env: NodeJS.ProcessEnv;

  private config: SchoolPassConfig | undefined;
  private tokens: TokenManager | undefined;
  private identity: SchoolPassIdentity | undefined;
  /** Mirror of the current access token — the refresh body needs it, and
   *  `TokenManager` does not hand it to the refresh callback. */
  private currentAccessToken = '';
  private bootstrapInFlight: Promise<void> | undefined;

  constructor(opts: SchoolPassClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl;
    this.env = opts.env ?? process.env;
  }

  /** Resolve config lazily; throws {@link SchoolPassConfigError} if unset. */
  private requireConfig(): SchoolPassConfig {
    if (!this.config) this.config = resolveConfig(this.env);
    return this.config;
  }

  /** The identity we authenticated as (available after {@link ensureSession}). */
  async getIdentity(): Promise<SchoolPassIdentity> {
    await this.ensureSession();
    return this.identity!;
  }

  /**
   * The parent's own member id — the `memberId` query param most parent-scoped
   * endpoints accept to disambiguate the record. Resolves the session first.
   */
  async getMemberId(): Promise<number> {
    await this.ensureSession();
    return this.identity!.userId;
  }

  /** The configured school code (tenant id). */
  get schoolCode(): number {
    return this.requireConfig().schoolCode;
  }

  /**
   * Ensure a live session exists, running the login bootstrap at most once for a
   * burst of concurrent callers.
   */
  async ensureSession(): Promise<void> {
    if (this.tokens) return;
    if (!this.bootstrapInFlight) {
      const config = this.requireConfig();
      this.bootstrapInFlight = (async () => {
        // A cached session carries BOTH halves. Restoring only the tokens would
        // skip the login and then crash on the first parent-scoped call, since
        // getMemberId() reads `this.identity!.userId` behind a non-null
        // assertion — so a record without the identity is not usable at all.
        const cache = createSessionCache(config);
        const restored = cache?.load() ?? null;
        const { identity, tokens } = restored ?? (await login(config, this.fetchImpl));
        this.identity = identity;
        this.currentAccessToken = tokens.accessToken;
        if (restored === null && cache !== null) {
          try {
            cache.save({ identity, tokens });
          } catch (err) {
            reportCacheWriteFailure(err);
          }
        }
        this.tokens = new TokenManager({
          initial: tokens,
          // The manager persists after every refresh, which is what stops the
          // cached copy going stale — through a view that re-attaches the
          // identity, so one file always holds a complete session.
          persistence: tokenView(cache, identity) ?? undefined,
          onPersistError: reportCacheWriteFailure,
          refresh: async (rt) => {
            const next = await refreshTokens(config, this.currentAccessToken, rt, this.fetchImpl);
            this.currentAccessToken = next.accessToken;
            return next;
          },
        });
      })().finally(() => {
        this.bootstrapInFlight = undefined;
      });
    }
    await this.bootstrapInFlight;
  }

  /** Discard the current session so the next call re-bootstraps from scratch. */
  private resetSession(): void {
    this.tokens = undefined;
    this.identity = undefined;
    this.currentAccessToken = '';
  }

  /**
   * Perform an authenticated request. Adds `Authorization` + `AppCode`, refreshes
   * proactively, and on a 401 refreshes once and replays once — falling back to a
   * full re-login if the refresh token is dead. Throws {@link SchoolPassApiError}
   * on a non-2xx response.
   */
  async request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    opts: { query?: QueryParams; body?: unknown } = {},
  ): Promise<unknown> {
    await this.ensureSession();
    const config = this.requireConfig();
    const url =
      `${apiBaseUrl(config.apiHost)}${path}` +
      (opts.query ? buildQueryString(opts.query) : '');

    const send = async (token: string) =>
      sendRequest(url, {
        method,
        headers: buildHeaders(config.schoolCode, { Authorization: `Bearer ${token}` }),
        body: opts.body,
        fetchImpl: this.fetchImpl,
      });

    const token = await this.tokens!.getAccessToken();
    this.currentAccessToken = token;
    let res = await send(token);

    if (res.status === 401) {
      // Try a refresh-and-replay; if the refresh path is dead, re-login fully.
      try {
        await this.tokens!.refreshNow();
        this.currentAccessToken = await this.tokens!.getAccessToken();
      } catch {
        this.resetSession();
        await this.ensureSession();
      }
      res = await send(this.currentAccessToken);
    }

    if (res.status < 200 || res.status >= 300) {
      throw new SchoolPassApiError(
        res.status,
        path,
        typeof res.body === 'string' ? res.body : JSON.stringify(res.body),
      );
    }
    return res.body;
  }

  /** Convenience GET returning the parsed body. */
  get(path: string, query?: QueryParams): Promise<unknown> {
    return this.request('GET', path, { query });
  }

  /** Convenience POST returning the parsed body. */
  post(path: string, body?: unknown, query?: QueryParams): Promise<unknown> {
    return this.request('POST', path, { body, query });
  }

  /**
   * Submit a student dismissal/arrival change (`POST studentchange`). The body
   * shape mirrors the SchoolPass app's own `createSubmitPayload`; `parentMemberId`
   * equals the body's `modifiedBy` (the parent member id), exactly as the app
   * sends it. Returns the parsed response.
   */
  async submitStudentChange(body: Record<string, unknown>): Promise<unknown> {
    const memberId = await this.getMemberId();
    return this.post(ENDPOINTS.studentChange, { ...body, modifiedBy: memberId }, {
      schoolCode: this.schoolCode,
      parentMemberId: memberId,
    });
  }

  /**
   * Delete a previously-submitted change series (`DELETE
   * studentchange/DeleteMobileChange`). Keyed on the `changeSeriesId` the
   * calendar reports; `changeType`/`adType`/`dt` scope which occurrence to
   * remove.
   */
  async deleteStudentChange(args: {
    changeSeriesId: number;
    changeType: number;
    adType: number;
    date: string;
  }): Promise<unknown> {
    return this.request('DELETE', ENDPOINTS.deleteStudentChange, {
      query: {
        schoolCode: this.schoolCode,
        ChangeSeriesId: args.changeSeriesId,
        ChangeType: args.changeType,
        ADType: args.adType,
        dt: args.date,
      },
    });
  }

  /**
   * Healthcheck: an unauthenticated `version` read (proves reachability + the
   * region host) followed by a session bootstrap (proves the credentials). Kept
   * separate so a connectivity problem is distinguishable from an auth problem.
   */
  async healthcheck(): Promise<{
    reachable: boolean;
    version: unknown;
    authenticated: boolean;
    identity?: { userId: number; userType: number; name?: string };
    error?: string;
  }> {
    const config = this.requireConfig();
    let version: unknown;
    let reachable = false;
    try {
      const res = await sendRequest(
        `${apiBaseUrl(config.apiHost)}${ENDPOINTS.version}` +
          buildQueryString({ schoolCode: config.schoolCode }),
        { method: 'GET', headers: buildHeaders(config.schoolCode), fetchImpl: this.fetchImpl },
      );
      reachable = res.status >= 200 && res.status < 300;
      version = res.body;
    } catch (err) {
      return { reachable: false, version: undefined, authenticated: false, error: String(err) };
    }
    try {
      await this.ensureSession();
      const id = this.identity!;
      return {
        reachable,
        version,
        authenticated: true,
        identity: {
          userId: id.userId,
          userType: id.userType,
          name: [id.firstName, id.lastName].filter(Boolean).join(' ') || undefined,
        },
      };
    } catch (err) {
      return { reachable, version, authenticated: false, error: String(err) };
    }
  }
}

/**
 * Process-wide client singleton. Built here (not in a registrar) so the
 * deferred-config-error pattern holds: construction does no I/O and never
 * throws, so the server boots without credentials and the config error surfaces
 * on the first tool call.
 */
export const client = new SchoolPassClient();
