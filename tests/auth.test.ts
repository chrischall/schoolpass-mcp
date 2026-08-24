import { describe, expect, it, vi } from 'vitest';
import {
  fetchIdentities,
  login,
  pickIdentity,
  refreshToken,
  requestToken,
  tokenExpiryMs,
  type SchoolPassIdentity,
} from '../src/auth.js';
import type { SchoolPassConfig } from '../src/config.js';
import { UserType, type FetchLike } from '../src/protocol.js';

const config: SchoolPassConfig = {
  email: 'parent@example.com',
  password: 'secret',
  schoolCode: 1183,
  apiHost: 'busapi-east16-ss.school-pass.net',
};

/** Mint a JWT with the given exp (epoch seconds). Signature is irrelevant. */
function jwt(expSeconds: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ exp: expSeconds })}.sig`;
}

/** A FetchLike returning one canned JSON response, capturing the last request. */
function mockFetch(
  status: number,
  body: unknown,
): { fetchImpl: FetchLike; calls: { url: string; init: Parameters<FetchLike>[1] }[] } {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { fetchImpl, calls };
}

describe('pickIdentity', () => {
  const parent: SchoolPassIdentity = { userId: 5, userType: UserType.Parent, raw: {} };
  const staff: SchoolPassIdentity = { userId: 9, userType: UserType.Staff, raw: {} };

  it('prefers a Parent identity when several exist', () => {
    expect(pickIdentity([staff, parent]).userId).toBe(5);
  });

  it('falls back to the sole identity when there is exactly one', () => {
    expect(pickIdentity([staff]).userId).toBe(9);
  });

  it('throws when there are no identities', () => {
    expect(() => pickIdentity([])).toThrow(/no user identities/i);
  });

  it('throws when several identities exist but none is a Parent', () => {
    expect(() => pickIdentity([staff, { userId: 1, userType: UserType.Teacher, raw: {} }])).toThrow(
      /parent/i,
    );
  });
});

describe('tokenExpiryMs', () => {
  it('reads the JWT exp claim (as ms)', () => {
    expect(tokenExpiryMs(jwt(2_000_000_000))).toBe(2_000_000_000 * 1000);
  });

  it('falls back to a TTL when the token is not a decodable JWT', () => {
    const now = 1_000_000;
    expect(tokenExpiryMs('not-a-jwt', now)).toBeGreaterThan(now);
  });
});

describe('fetchIdentities', () => {
  it('normalizes the live nested-`user` identity shape', async () => {
    // The real Auth/users element nests id + type under `user`:
    //   { user: { userType, internalId }, firstName, lastName, email, … }
    const { fetchImpl, calls } = mockFetch(200, [
      { user: { userType: 3, internalId: 15348 }, firstName: 'Pat', lastName: 'Guardian', email: 'parent@example.com' },
    ]);
    const ids = await fetchIdentities(config, fetchImpl);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatchObject({ userId: 15348, userType: 3, firstName: 'Pat', email: 'parent@example.com' });
    // AppCode header is present and equals the school code.
    expect(calls[0]!.init.headers.AppCode).toBe('1183');
    expect(calls[0]!.url).toContain('/api/Auth/users');
  });

  it('also accepts a flat top-level identity record', async () => {
    const { fetchImpl } = mockFetch(200, [
      { userId: 5, userType: 3, firstName: 'Pat', login: 'parent@example.com' },
    ]);
    const ids = await fetchIdentities(config, fetchImpl);
    expect(ids[0]).toMatchObject({ userId: 5, userType: 3, email: 'parent@example.com' });
  });

  it('unwraps an envelope-wrapped identity array', async () => {
    const { fetchImpl } = mockFetch(200, { users: [{ id: 7, type: 3 }] });
    const ids = await fetchIdentities(config, fetchImpl);
    expect(ids[0]).toMatchObject({ userId: 7, userType: 3 });
  });

  it('does NOT retry — a 401 throws once', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    await expect(fetchIdentities(config, fetchImpl)).rejects.toThrow(/rejected/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces a 500 as a transient upstream error (not a credential problem)', async () => {
    const { fetchImpl } = mockFetch(500, { message: 'boom' });
    const err = await fetchIdentities(config, fetchImpl).catch((e) => e);
    expect(err.hint).toMatch(/transient|retry later/i);
  });

  it('accepts a single identity object not wrapped in an array', async () => {
    const { fetchImpl } = mockFetch(200, { userId: 8, userType: 3 });
    const ids = await fetchIdentities(config, fetchImpl);
    expect(ids).toEqual([{ userId: 8, userType: 3, firstName: undefined, lastName: undefined, email: undefined, raw: { userId: 8, userType: 3 } }]);
  });

  it('drops records missing userId or userType', async () => {
    const { fetchImpl } = mockFetch(200, [{ firstName: 'NoIds' }, { userId: 3, userType: 3 }]);
    const ids = await fetchIdentities(config, fetchImpl);
    expect(ids).toHaveLength(1);
    expect(ids[0]!.userId).toBe(3);
  });

  it('returns an empty list for an unrecognized envelope', async () => {
    const { fetchImpl } = mockFetch(200, { unexpected: true });
    expect(await fetchIdentities(config, fetchImpl)).toEqual([]);
  });

  it('returns an empty list when the body is a bare string', async () => {
    const { fetchImpl } = mockFetch(200, 'not json at all');
    expect(await fetchIdentities(config, fetchImpl)).toEqual([]);
  });

  it('skips non-object elements inside the identity array', async () => {
    const { fetchImpl } = mockFetch(200, [null, 'x', { userId: 4, userType: 3 }]);
    const ids = await fetchIdentities(config, fetchImpl);
    expect(ids).toHaveLength(1);
    expect(ids[0]!.userId).toBe(4);
  });
});

describe('requestToken', () => {
  it('extracts access + refresh tokens and derives expiry', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const { fetchImpl, calls } = mockFetch(200, {
      access_token: jwt(exp),
      refresh_token: 'refresh-abc',
    });
    const tokens = await requestToken(config, { userId: 5, userType: 3, raw: {} }, fetchImpl);
    expect(tokens.refreshToken).toBe('refresh-abc');
    expect(tokens.expiresAt).toBe(exp * 1000);
    // Body carries the chosen identity.
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toMatchObject({ schoolCode: 1183, userId: 5, userType: 3, authType: 'Credentials' });
  });

  it('throws when the token endpoint returns no access token', async () => {
    const { fetchImpl } = mockFetch(200, { refresh_token: 'x' });
    await expect(requestToken(config, { userId: 5, userType: 3, raw: {} }, fetchImpl)).rejects.toThrow(
      /no access token/i,
    );
  });

  it('throws no-access-token when the token body is a plain string', async () => {
    const { fetchImpl } = mockFetch(200, 'unexpected string');
    await expect(requestToken(config, { userId: 5, userType: 3, raw: {} }, fetchImpl)).rejects.toThrow(
      /no access token/i,
    );
  });

  it('unwraps a payload-wrapped token envelope', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const { fetchImpl } = mockFetch(200, {
      payload: { access_token: jwt(exp), refresh_token: 'r' },
    });
    const tokens = await requestToken(config, { userId: 5, userType: 3, raw: {} }, fetchImpl);
    expect(tokens.refreshToken).toBe('r');
  });

  it('coerces a string userId/userType from Auth/users', async () => {
    const { fetchImpl } = mockFetch(200, [{ userId: '5', userType: '3' }]);
    const ids = await fetchIdentities(config, fetchImpl);
    expect(ids[0]).toMatchObject({ userId: 5, userType: 3 });
  });

  it('rejects with a string error body (no message field)', async () => {
    const { fetchImpl } = mockFetch(400, 'plain error text');
    await expect(requestToken(config, { userId: 5, userType: 3, raw: {} }, fetchImpl)).rejects.toThrow(
      /rejected/i,
    );
  });

  it('rejects with a plain-object error body (no message field)', async () => {
    const { fetchImpl } = mockFetch(400, { code: 42 });
    await expect(fetchIdentities(config, fetchImpl)).rejects.toThrow(/rejected/i);
  });
});

describe('login', () => {
  it('runs users → token and returns the parent identity + tokens', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    let call = 0;
    const fetchImpl: FetchLike = async (url) => {
      call += 1;
      if (url.includes('Auth/users')) {
        return new Response(JSON.stringify([{ userId: 5, userType: 3 }]), { status: 200 });
      }
      return new Response(JSON.stringify({ access_token: jwt(exp), refresh_token: 'r' }), { status: 200 });
    };
    const { identity, tokens } = await login(config, fetchImpl);
    expect(identity.userId).toBe(5);
    expect(tokens.accessToken).toContain('.');
    expect(call).toBe(2);
  });
});

describe('refreshToken', () => {
  it('posts access + refresh tokens and returns fresh ones', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const { fetchImpl, calls } = mockFetch(200, { access_token: jwt(exp), refresh_token: 'r2' });
    const next = await refreshToken(config, 'old-access', 'old-refresh', fetchImpl);
    expect(next.refreshToken).toBe('r2');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toMatchObject({ access_token: 'old-access', refresh_token: 'old-refresh' });
  });

  it('keeps the current refresh token when the response omits a new one', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const { fetchImpl } = mockFetch(200, { access_token: jwt(exp) });
    const next = await refreshToken(config, 'a', 'keep-me', fetchImpl);
    expect(next.refreshToken).toBe('keep-me');
  });

  it('throws on a failed refresh', async () => {
    const { fetchImpl } = mockFetch(400, 'bad');
    await expect(refreshToken(config, 'a', 'b', fetchImpl)).rejects.toThrow(/refresh failed/i);
  });
});
