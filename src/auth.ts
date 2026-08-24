/**
 * Authentication bootstrap for SchoolPass.
 *
 * The flow the web/mobile clients use (and this server replicates server-side —
 * no browser, no bridge):
 *
 *   1. `POST Auth/users`  {schoolCode,email,password,authType:"Credentials"}
 *        → the identities that email owns at the school. A parent can have more
 *          than one (multiple roles); we pick the Parent identity.
 *   2. `POST Auth/token`  {schoolCode,userId,userType,password,authType}
 *        → { access_token, refresh_token, … } (JWT access token).
 *   3. `POST Auth/token/refresh` {schoolCode,access_token,refresh_token}
 *        → fresh tokens. Used by the client's TokenManager.
 *
 * The auth-response field NAMES (`access_token`, `refresh_token`) are confirmed
 * by the spec's `RefreshTokenInputModel`; the surrounding envelope and the
 * `Auth/users` array shape are parsed defensively and pinned by the live check
 * in `scripts/live-check.mjs` / `docs/SCHOOLPASS-API.md`.
 *
 * **Never auto-retry a rejected credential.** SchoolPass fronts its login form
 * with reCAPTCHA; hammering the API auth endpoint with wrong passwords is the
 * kind of thing that gets an account challenged. On a 400/401 from the auth
 * endpoints we surface the error and stop — one attempt, no loop.
 */

import { McpToolError, decodeJwtExp } from '@chrischall/mcp-utils';
import type { BearerTokens, RefreshedTokens } from '@chrischall/mcp-utils/session';
import type { SchoolPassConfig } from './config.js';
import {
  AUTH_TYPE_CREDENTIALS,
  ENDPOINTS,
  UserType,
  apiBaseUrl,
  buildHeaders,
  sendRequest,
  type FetchLike,
} from './protocol.js';

/** A user identity returned by `Auth/users`, normalized across field-name drift. */
export interface SchoolPassIdentity {
  userId: number;
  userType: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  /** The raw record, so callers can inspect fields we did not normalize. */
  raw: Record<string, unknown>;
}

/** Fallback access-token lifetime when the JWT carries no usable `exp` claim. */
const FALLBACK_TOKEN_TTL_MS = 30 * 60 * 1000;

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
      ? Number(v)
      : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** Throw a rejection that must NOT be retried in a loop (see module doc). */
function authRejected(status: number, path: string, body: unknown): never {
  const detail =
    typeof body === 'string'
      ? body
      : typeof (body as { message?: unknown })?.message === 'string'
        ? (body as { message: string }).message
        : JSON.stringify(body);
  throw new McpToolError(
    `SchoolPass login was rejected (HTTP ${status} on ${path}).`,
    {
      hint:
        status === 400 || status === 401
          ? 'Check SCHOOLPASS_EMAIL / SCHOOLPASS_PASSWORD / SCHOOLPASS_SCHOOL_CODE. Do NOT retry with guesses — repeated failures can trigger a captcha challenge on the account.'
          : 'The auth endpoint returned an unexpected status; treat as a transient upstream error and retry later.',
      cause: detail,
    },
  );
}

/** Normalize one raw `Auth/users` record into a {@link SchoolPassIdentity}. */
function normalizeIdentity(rec: Record<string, unknown>): SchoolPassIdentity | undefined {
  // The live shape nests the id + type under a `user` object:
  //   { user: { userType, internalId }, firstName, lastName, email, … }
  // Fall back to top-level variants so a future flatter shape still parses.
  const user =
    typeof rec['user'] === 'object' && rec['user'] !== null
      ? (rec['user'] as Record<string, unknown>)
      : {};
  const userId = num(
    rec['userId'] ?? rec['id'] ?? rec['internalUserId'] ?? rec['userID'] ?? user['internalId'] ?? user['userId'] ?? user['id'],
  );
  const userType = num(rec['userType'] ?? rec['type'] ?? rec['userTypeId'] ?? user['userType']);
  if (userId === undefined || userType === undefined) return undefined;
  return {
    userId,
    userType,
    firstName: str(rec['firstName'] ?? rec['firstname']),
    lastName: str(rec['lastName'] ?? rec['lastname']),
    email: str(rec['email'] ?? rec['login'] ?? rec['emailAddress']),
    raw: rec,
  };
}

/** Pull the identity array out of whatever envelope `Auth/users` returns. */
function extractIdentityArray(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null);
  if (typeof body === 'object' && body !== null) {
    for (const key of ['users', 'data', 'result', 'payload', 'items']) {
      const v = (body as Record<string, unknown>)[key];
      if (Array.isArray(v)) {
        return v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null);
      }
    }
    // A single identity object (not wrapped in an array).
    if ('userId' in body || 'id' in body || 'userType' in body || 'type' in body) {
      return [body as Record<string, unknown>];
    }
  }
  return [];
}

/**
 * Step 1: fetch the identities the configured email owns at the school. Returns
 * the normalized list; a login rejection throws (never retried).
 */
export async function fetchIdentities(
  config: SchoolPassConfig,
  fetchImpl?: FetchLike,
): Promise<SchoolPassIdentity[]> {
  const url = `${apiBaseUrl(config.apiHost)}${ENDPOINTS.authUsers}`;
  const res = await sendRequest(url, {
    method: 'POST',
    headers: buildHeaders(config.schoolCode),
    body: {
      schoolCode: config.schoolCode,
      email: config.email,
      password: config.password,
      ssoToken: null,
      authType: AUTH_TYPE_CREDENTIALS,
    },
    fetchImpl,
  });
  if (res.status < 200 || res.status >= 300) authRejected(res.status, ENDPOINTS.authUsers, res.body);
  return extractIdentityArray(res.body)
    .map(normalizeIdentity)
    .filter((x): x is SchoolPassIdentity => x !== undefined);
}

/**
 * Pick the identity to authenticate as. Prefers a {@link UserType.Parent}
 * identity (this is a parent-scoped server); falls back to the sole identity
 * when there is exactly one. Throws if no suitable identity exists.
 */
export function pickIdentity(identities: SchoolPassIdentity[]): SchoolPassIdentity {
  const parent = identities.find((i) => i.userType === UserType.Parent);
  if (parent) return parent;
  if (identities.length === 1) return identities[0]!;
  if (identities.length === 0) {
    throw new McpToolError('SchoolPass login returned no user identities for this email.', {
      hint: 'Confirm the email is enrolled at this school (SCHOOLPASS_SCHOOL_CODE).',
    });
  }
  throw new McpToolError(
    `SchoolPass login returned ${identities.length} identities but none is a Parent account; ` +
      `this server only supports parent-scoped access.`,
    { hint: `Identity user types seen: ${identities.map((i) => i.userType).join(', ')}.` },
  );
}

/** Derive an absolute expiry (epoch ms) from a JWT access token, with a fallback. */
export function tokenExpiryMs(accessToken: string, now: number = Date.now()): number {
  try {
    return decodeJwtExp(accessToken) * 1000;
  } catch {
    return now + FALLBACK_TOKEN_TTL_MS;
  }
}

/** Pull `{access_token, refresh_token}` out of the token-endpoint envelope. */
function extractTokens(body: unknown): { accessToken: string; refreshToken?: string } {
  const obj =
    typeof body === 'object' && body !== null
      ? ((body as Record<string, unknown>)['payload'] &&
        typeof (body as Record<string, unknown>)['payload'] === 'object'
          ? ((body as Record<string, unknown>)['payload'] as Record<string, unknown>)
          : (body as Record<string, unknown>))
      : {};
  const accessToken = str(obj['access_token'] ?? obj['accessToken'] ?? obj['token']);
  const refreshToken = str(obj['refresh_token'] ?? obj['refreshToken']);
  if (!accessToken) {
    throw new McpToolError('SchoolPass token endpoint returned no access token.', {
      hint: 'The auth-response shape may have changed; re-verify against docs/SCHOOLPASS-API.md.',
    });
  }
  return { accessToken, refreshToken };
}

/**
 * Step 2: exchange a chosen identity for bearer tokens. Returns
 * {@link BearerTokens} suitable for a `TokenManager`.
 */
export async function requestToken(
  config: SchoolPassConfig,
  identity: SchoolPassIdentity,
  fetchImpl?: FetchLike,
): Promise<BearerTokens> {
  const url = `${apiBaseUrl(config.apiHost)}${ENDPOINTS.authToken}`;
  const res = await sendRequest(url, {
    method: 'POST',
    headers: buildHeaders(config.schoolCode),
    body: {
      schoolCode: config.schoolCode,
      userId: identity.userId,
      userType: identity.userType,
      password: config.password,
      ssoToken: null,
      authType: AUTH_TYPE_CREDENTIALS,
    },
    fetchImpl,
  });
  if (res.status < 200 || res.status >= 300) authRejected(res.status, ENDPOINTS.authToken, res.body);
  const { accessToken, refreshToken } = extractTokens(res.body);
  return { accessToken, refreshToken, expiresAt: tokenExpiryMs(accessToken) };
}

/**
 * Full bootstrap: identities → pick parent → token. Used by the client on first
 * authenticated call.
 */
export async function login(config: SchoolPassConfig, fetchImpl?: FetchLike): Promise<{
  identity: SchoolPassIdentity;
  tokens: BearerTokens;
}> {
  const identity = pickIdentity(await fetchIdentities(config, fetchImpl));
  const tokens = await requestToken(config, identity, fetchImpl);
  return { identity, tokens };
}

/**
 * Step 3: refresh. Shaped as a `TokenManager` refresh callback — it needs the
 * current access token as well as the refresh token, so the caller closes over
 * a getter for the former.
 */
export async function refreshToken(
  config: SchoolPassConfig,
  currentAccessToken: string,
  currentRefreshToken: string,
  fetchImpl?: FetchLike,
): Promise<RefreshedTokens> {
  const url = `${apiBaseUrl(config.apiHost)}${ENDPOINTS.authTokenRefresh}`;
  const res = await sendRequest(url, {
    method: 'POST',
    headers: buildHeaders(config.schoolCode),
    body: {
      schoolCode: config.schoolCode,
      access_token: currentAccessToken,
      refresh_token: currentRefreshToken,
    },
    fetchImpl,
  });
  if (res.status < 200 || res.status >= 300) {
    // A failed refresh is not a credential-guessing risk, but a full re-login is
    // the recovery — surface it clearly rather than looping.
    throw new McpToolError(`SchoolPass token refresh failed (HTTP ${res.status}).`, {
      hint: 'The refresh token likely expired; the next tool call will re-run a full login.',
    });
  }
  const { accessToken, refreshToken: newRefresh } = extractTokens(res.body);
  return {
    accessToken,
    refreshToken: newRefresh ?? currentRefreshToken,
    expiresAt: tokenExpiryMs(accessToken),
  };
}
