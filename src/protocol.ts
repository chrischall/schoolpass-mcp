/**
 * Wire-level constants and helpers for the SchoolPass REST API — the JSON API
 * (`busapi-<region>-ss.school-pass.net/api/`) behind the SchoolPass web app and
 * mobile app. This is a documented ASP.NET Core API (its own Swagger lives at
 * `/swagger/v1/swagger.json`), so unlike the reverse-engineered fleet repos the
 * shapes here come from that spec; the auth-response fields and the parent tool
 * shapes are additionally verified live — see `docs/SCHOOLPASS-API.md`.
 *
 * Kept as a leaf module (no imports from `client.ts` / `auth.ts`) so the
 * authentication bootstrap and the authenticated client can share it without an
 * import cycle.
 *
 * Two facts that shape everything else:
 *
 *  - **Every request carries an `AppCode: <schoolCode>` header.** It is the
 *    tenant selector; the same host serves many schools and a call without it
 *    (or with the wrong one) 401s. It is NOT a secret — it is a small integer
 *    that identifies the school (1183 = Scholars Academy).
 *  - **The API is region-sharded.** A school lives on one regional host
 *    (`busapi-east16-ss.school-pass.net` for Scholars Academy); the host is
 *    configurable so a school in another region can point at its own shard.
 */

import { McpToolError, truncateErrorMessage, withAmbientCancellation } from '@chrischall/mcp-utils';

/** Default regional API host. Overridable via `SCHOOLPASS_API_HOST`. */
export const DEFAULT_API_HOST = 'busapi-east16-ss.school-pass.net';

/**
 * How long one upstream request may take before it is abandoned. Without a
 * deadline a stalled TCP connection to the regional host hung the tool until
 * the MCP client gave up — and for the non-idempotent `POST studentchange` a
 * client-side timeout reads as "nothing happened" and invites the retry that
 * duplicates a child's change (`docs/SCHOOLPASS-API.md`, "Traps").
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Build the API root for a host. Ends in `/` so endpoint paths concatenate
 * directly. Accepts a bare host (`busapi-east16-ss.school-pass.net`) or a full
 * origin (`https://…`); a bare host is assumed https.
 */
export function apiBaseUrl(host: string): string {
  const origin = /^https?:\/\//i.test(host) ? host : `https://${host}`;
  return `${origin.replace(/\/+$/, '')}/api/`;
}

/**
 * `UserType` enum, index-aligned with the API's `int32`-backed string enum
 * (spec `components.schemas.UserType`). A parent account is {@link Parent} (3);
 * `memberType` in the web app's localStorage matches this.
 */
export enum UserType {
  NA = 0,
  Visitor = 1,
  Student = 2,
  Parent = 3,
  Staff = 4,
  Teacher = 5,
  FlaggedVisitor = 6,
}

/**
 * `AuthType` enum (spec `components.schemas.AuthType`). Credential login is
 * {@link Credentials} (0). The API accepts the STRING name (`"Credentials"`)
 * on the wire — the web bundle posts `authType:"credentials"` — not the int.
 */
export enum AuthType {
  Credentials = 0,
  Google = 1,
  Blackbaud = 2,
  OneTimeToken = 3,
}

/** Wire string the API expects for the credential-login `authType`. */
export const AUTH_TYPE_CREDENTIALS = 'Credentials';

/**
 * `StudentChangeType` — the kind of dismissal/arrival change (int32-backed).
 * The values are what the calendar reports (`studentChangeType`) and what a
 * `studentchange` write sends as `changeType`. Verified against the live
 * calendar (a default carpool reads `studentChangeType: 4`).
 */
export enum StudentChangeType {
  NA = 0,
  Absent = 1,
  LateArrival = 2,
  EarlyDismissal = 3,
  Carpool = 4,
  Activity = 5,
  Bus = 6,
  Virtual = 7,
}

/**
 * `ArrivalDeparture` (`adType`) — which side of the day a change applies to.
 * The calendar reports `adType: 2` (Arrival) and `adType: 3` (Departure)
 * entries for the same day; a dismissal change is `Departure`.
 */
export enum AdType {
  NA = 0,
  Neither = 1,
  Arrival = 2,
  Departure = 3,
  Both = 4,
}

/**
 * Endpoint paths used by this server, relative to {@link apiBaseUrl}. Auth
 * paths are unversioned; most data endpoints are unversioned `Controller`
 * routes, a few are `v2/...`. Only the parent-reachable subset is listed.
 */
export const ENDPOINTS = {
  authUsers: 'Auth/users',
  authToken: 'Auth/token',
  authTokenRefresh: 'Auth/token/refresh',
  authTokenRevoke: 'Auth/token/revoke',
  version: 'version',
  configSettings: 'Config/configsettings',
  parentProfile: 'parent/profile',
  parentStudents: 'parent/getstudents',
  parentDrivers: 'parent/parentdrivers',
  studentCalendar: 'Student/StudentCalendar',
  pickupChanges: 'PickupChange/GetChanges',
  pickupChangesSince: 'PickupChange/GetChangesSince',
  dismissalLocations: 'dismissal/getDismissalLocations',
  schoolInfoBasic: 'SchoolInfo/GetBasicSchoolInfo',
  studentChange: 'studentchange',
  deleteStudentChange: 'studentchange/DeleteMobileChange',
} as const;

/**
 * Error thrown when the SchoolPass API returns a non-2xx status. Unlike some
 * fleet APIs, SchoolPass uses REAL HTTP status codes — a 401 means the token or
 * `AppCode` is wrong, a 403 means the account lacks permission for that
 * endpoint (common for a parent hitting an admin route), a 500 is upstream.
 */
export class SchoolPassApiError extends McpToolError {
  readonly status: number;
  readonly path: string;

  constructor(
    status: number,
    path: string,
    body: string,
    opts?: { hint?: string; cause?: unknown },
  ) {
    const detail = truncateErrorMessage(body || '<empty body>');
    super(`SchoolPass API error on ${path}: HTTP ${status} — ${detail}`, {
      hint:
        opts?.hint ??
        (status === 401
          ? 'Session token or AppCode (schoolCode) was rejected — the login may have expired, or SCHOOLPASS_SCHOOL_CODE is wrong.'
          : status === 403
            ? 'This account is not authorized for that endpoint. A parent login cannot reach admin-only routes.'
            : undefined),
      cause: opts?.cause,
    });
    this.name = 'SchoolPassApiError';
    this.status = status;
    this.path = path;
  }
}

/**
 * A request that hit {@link REQUEST_TIMEOUT_MS} (or the caller's own deadline)
 * before SchoolPass answered. Carries the original `TimeoutError` as `cause`
 * so `TokenManager` classifies it as an OUTAGE, not a dead credential — a slow
 * `Auth/token/refresh` must not destroy a still-good refresh token.
 *
 * Deliberately says nothing about whether the request landed: for a write the
 * honest answer is "unknown", and the submit tool reports exactly that rather
 * than throwing (an error would read as "nothing happened").
 */
export class SchoolPassTimeoutError extends McpToolError {
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number, cause: unknown) {
    const path = url.replace(/^[a-z]+:\/\/[^/]+\/api\//i, '').replace(/\?.*$/, '');
    super(`SchoolPass did not answer ${path} within ${timeoutMs} ms.`, {
      hint:
        'SchoolPass may be slow or unreachable. A read can simply be retried. For a write, re-read the ' +
        'calendar FIRST — the request may have landed after this gave up on it.',
      cause,
    });
    this.name = 'SchoolPassTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** Init accepted by {@link FetchLike} — a small, explicit subset of `RequestInit`. */
export interface SchoolPassRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  /** Fires on the request deadline OR the tool call's cancellation, whichever comes first. */
  signal?: AbortSignal;
}

/**
 * Injectable fetch. `fetch` is invoked as a method of `globalThis`, never stored
 * detached — a detached `globalThis.fetch` throws `Illegal invocation` in some
 * sandboxed runtimes while passing every Node test.
 */
export type FetchLike = (url: string, init: SchoolPassRequestInit) => Promise<Response>;

export const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

/**
 * Build the standard header set for a call. `AppCode` is always present;
 * `Authorization` is added by the client for authenticated calls. Extra headers
 * override defaults; `undefined` values are dropped so optional headers can be
 * passed inline.
 */
export function buildHeaders(
  schoolCode: number,
  extra?: Record<string, string | undefined>,
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    AppCode: String(schoolCode),
  };
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value !== undefined) headers[key] = value;
  }
  return headers;
}

/** A raw (not yet status-checked) response: parsed body plus HTTP status. */
export interface SchoolPassRawResponse {
  /** Parsed JSON when the body was JSON, else the raw text. */
  body: unknown;
  /** Whether {@link SchoolPassRawResponse.body} was parsed as JSON. */
  json: boolean;
  status: number;
  headers: Headers;
}

/**
 * Perform one API request and parse the body. Success is deliberately NOT
 * asserted here — the auth bootstrap inspects the raw status to tell a bad
 * credential (a real 400/401) from an outage, and the client's `withAuth`
 * needs to see a 401 to trigger a token refresh.
 */
export async function sendRequest(
  url: string,
  opts: {
    method: string;
    headers: Record<string, string>;
    body?: unknown;
    fetchImpl?: FetchLike;
    /** Override of {@link REQUEST_TIMEOUT_MS} (tests). */
    timeoutMs?: number;
  },
): Promise<SchoolPassRawResponse> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  // Our deadline, folded together with the tool call's own cancellation
  // (mcp-utils `currentCallSignal`): a request the caller has given up on is
  // stopped too, instead of holding the upstream connection for the full
  // budget. Which one fired is told apart by asking the deadline signal, not
  // by the error — both ends abort with an AbortError-shaped rejection.
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = withAmbientCancellation(deadline)!;
  // Raced against the signal as well as passed to fetch, so the deadline holds
  // even for a fetch implementation that ignores `signal` — the request must
  // never be able to hang the tool, whatever is behind `fetchImpl`.
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason as unknown);
    // A call cancelled before this request even started never fires `abort`
    // again, so the listener alone would wait forever on a fetch that ignores
    // the signal.
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const response = await Promise.race([
      fetchImpl(url, {
        method: opts.method,
        headers: opts.headers,
        signal,
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      }),
      aborted,
    ]);
    const text = await Promise.race([response.text(), aborted]);
    return parseRaw(text, response);
  } catch (err) {
    if (deadline.aborted) throw new SchoolPassTimeoutError(url, timeoutMs, err);
    throw err;
  } finally {
    // The ambient signal outlives this request (it is the whole tool call's),
    // so the listener must not: one leaked closure per request otherwise.
    signal.removeEventListener('abort', onAbort!);
  }
}

/** Parse the response text into a {@link SchoolPassRawResponse}. */
function parseRaw(text: string, response: Response): SchoolPassRawResponse {
  let body: unknown = text;
  let json = false;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
      json = true;
    } catch {
      // Non-JSON body (e.g. a plain-string endpoint like `version`, or an error
      // page). Leave it as text; callers decide whether that is acceptable.
    }
  }
  return { body, json, status: response.status, headers: response.headers };
}
