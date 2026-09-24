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
import { createHash } from 'node:crypto';
import { buildQueryString } from '@chrischall/mcp-utils';
import {
  SchoolPassAuthRejectedError,
  login,
  refreshToken as refreshTokens,
  type SchoolPassIdentity,
} from './auth.js';
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

/**
 * A digest of the credentials a login sends — what the rejection latch is keyed
 * on, so a corrected password (or email / school) gets exactly one fresh try.
 * Hashed so the latch never holds a second copy of the password.
 */
function credentialFingerprint(config: SchoolPassConfig): string {
  return createHash('sha256')
    .update(`${config.email}\0${config.password}\0${config.schoolCode}`)
    .digest('hex');
}

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
  /**
   * A login SchoolPass refused (400/401), latched for the life of the process
   * against the credentials that earned it. Every later call rethrows it
   * instead of sending the same refused password again — within one call the
   * login was already one-attempt, but without this a model retry, a hosted
   * healthcheck poller, or any later tool call re-ran the login each time.
   */
  private rejection: { error: SchoolPassAuthRejectedError; fingerprint: string } | undefined;

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
    this.checkRejectionLatch();
    if (this.tokens) return;
    if (!this.bootstrapInFlight) {
      const config = this.requireConfig();
      this.bootstrapInFlight = (async () => {
        // A cached session carries BOTH halves. Restoring only the tokens would
        // skip the login and then crash on the first parent-scoped call, since
        // getMemberId() reads `this.identity!.userId` behind a non-null
        // assertion — so a record without the identity is not usable at all.
        // this.env, not process.env: the client takes an injected environment
        // (resolveConfig already uses it), and reading the ambient one here made
        // the cache ignore a caller's configuration — and let the test suite
        // disable it through a channel the client was not actually consulting.
        const cache = createSessionCache(config, this.env);
        // The view restores the identity; the access token is restored here. The
        // refresh contract is {schoolCode, access_token, refresh_token}, and the
        // manager refreshes an expired restored record INSIDE getAccessToken()
        // below — before that call's result could set currentAccessToken. Left
        // empty, the server rejects the refresh as revoked, so every cold start
        // with an expired access token threw away a good session for a login.
        const view = tokenView(cache, {
          get: () => this.identity,
          set: (identity) => {
            this.identity = identity;
          },
        });
        const persistence = view && {
          ...view,
          load: () => {
            const restored = view.load();
            if (restored) this.currentAccessToken = restored.accessToken;
            return restored;
          },
        };
        // The login is handed to the manager as a BOOTSTRAP FUNCTION, not run
        // here and passed in as tokens. Only the function form lets the manager
        // recover on its own: when a refresh is rejected as revoked it clears the
        // persisted record and re-runs this login. With eager tokens it has
        // nothing to fall back on, so a dead refresh token restored from disk
        // failed every call — and every restart — until session.json was
        // deleted by hand (fleet-audit#14).
        const tokens = new TokenManager({
          // Also the path a dead refresh token falls back to, so the latch is
          // checked and set HERE, not only in ensureSession().
          initial: async () => {
            if (this.rejection) throw this.rejection.error;
            let fresh: Awaited<ReturnType<typeof login>>;
            try {
              fresh = await login(config, this.fetchImpl);
            } catch (err) {
              if (err instanceof SchoolPassAuthRejectedError && err.credentialRejected) {
                this.rejection = { error: err, fingerprint: credentialFingerprint(config) };
              }
              throw err;
            }
            this.identity = fresh.identity;
            this.currentAccessToken = fresh.tokens.accessToken;
            return fresh.tokens;
          },
          // The manager reads this once, persists after every login and refresh,
          // and clears it when the refresh token is dead — through a view that
          // carries the identity alongside, so one file always holds a
          // complete session.
          persistence,
          onPersistError: reportCacheWriteFailure,
          refresh: async (rt) => {
            const next = await refreshTokens(config, this.currentAccessToken, rt, this.fetchImpl);
            this.currentAccessToken = next.accessToken;
            return next;
          },
        });
        // Resolve a token now, so identity is populated before this returns
        // (getMemberId() reads it behind a non-null assertion): a restored
        // record supplies both halves; otherwise the bootstrap login does.
        this.currentAccessToken = await tokens.getAccessToken();
        this.tokens = tokens;
      })().finally(() => {
        this.bootstrapInFlight = undefined;
      });
    }
    await this.bootstrapInFlight;
  }

  /**
   * Rethrow a latched credential rejection — unless the configured credentials
   * have changed since, in which case drop the latch (and the stale config and
   * session) so the corrected credentials get one fresh attempt.
   */
  private checkRejectionLatch(): void {
    if (!this.rejection) return;
    let current: SchoolPassConfig;
    try {
      current = resolveConfig(this.env);
    } catch {
      throw this.rejection.error;
    }
    if (credentialFingerprint(current) === this.rejection.fingerprint) throw this.rejection.error;
    this.rejection = undefined;
    this.config = current;
    this.tokens = undefined;
    this.identity = undefined;
  }

  /**
   * Perform an authenticated request. Adds `Authorization` + `AppCode`, refreshes
   * proactively, and on a 401 refreshes once and replays once — falling back to a
   * full re-login (and a fresh cache record) if the refresh token is dead. Throws {@link SchoolPassApiError}
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

    // TokenManager.withAuth owns the 401 policy: refresh once and replay once,
    // with no second refresh if a concurrent caller already rotated the token.
    // A refresh the server rejects as revoked makes the manager clear the cache
    // and re-run the login bootstrap itself; a transient refresh failure (5xx,
    // network) surfaces instead, keeping the still-good refresh token. The
    // manager only reads `status`, so the parsed response rides alongside.
    let res!: Awaited<ReturnType<typeof send>>;
    await this.tokens!.withAuth(async (token) => {
      this.currentAccessToken = token;
      res = await send(token);
      return new Response(null, { status: res.status });
    });

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
