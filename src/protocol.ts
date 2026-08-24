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

import { McpToolError, truncateErrorMessage } from '@chrischall/mcp-utils';

/** Default regional API host. Overridable via `SCHOOLPASS_API_HOST`. */
export const DEFAULT_API_HOST = 'busapi-east16-ss.school-pass.net';

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

/** Init accepted by {@link FetchLike} — a small, explicit subset of `RequestInit`. */
export interface SchoolPassRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
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
  opts: { method: string; headers: Record<string, string>; body?: unknown; fetchImpl?: FetchLike },
): Promise<SchoolPassRawResponse> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const response = await fetchImpl(url, {
    method: opts.method,
    headers: opts.headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await response.text();
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
