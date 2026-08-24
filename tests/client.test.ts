import { describe, expect, it, vi } from 'vitest';
import { SchoolPassClient } from '../src/client.js';
import { SchoolPassApiError, type FetchLike } from '../src/protocol.js';
import { SchoolPassConfigError } from '../src/config.js';

const env = {
  SCHOOLPASS_EMAIL: 'parent@example.com',
  SCHOOLPASS_PASSWORD: 'secret',
  SCHOOLPASS_SCHOOL_CODE: '1183',
};

function jwt(expSeconds: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ exp: expSeconds })}.sig`;
}

const futureExp = () => Math.floor(Date.now() / 1000) + 3600;

/**
 * A scripted fetch: `Auth/users` and `Auth/token` always succeed; data calls are
 * handled by `onData(url, init)`.
 */
function scriptedFetch(
  onData: (url: string, init: Parameters<FetchLike>[1]) => Response,
): { fetchImpl: FetchLike; dataCalls: { url: string; init: Parameters<FetchLike>[1] }[] } {
  const dataCalls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    if (url.includes('Auth/users')) {
      return new Response(JSON.stringify([{ userId: 5, userType: 3 }]), { status: 200 });
    }
    if (url.includes('Auth/token/refresh')) {
      return new Response(JSON.stringify({ access_token: jwt(futureExp()), refresh_token: 'r2' }), {
        status: 200,
      });
    }
    if (url.includes('Auth/token')) {
      return new Response(JSON.stringify({ access_token: jwt(futureExp()), refresh_token: 'r1' }), {
        status: 200,
      });
    }
    dataCalls.push({ url, init });
    return onData(url, init);
  };
  return { fetchImpl, dataCalls };
}

describe('SchoolPassClient config', () => {
  it('does not throw at construction with no credentials', () => {
    expect(() => new SchoolPassClient({ env: {} })).not.toThrow();
  });

  it('throws a config error on the first call needing credentials', async () => {
    const client = new SchoolPassClient({ env: {} });
    await expect(client.getIdentity()).rejects.toBeInstanceOf(SchoolPassConfigError);
  });
});

describe('SchoolPassClient.request', () => {
  it('adds Authorization + AppCode headers and returns the parsed body', async () => {
    const { fetchImpl, dataCalls } = scriptedFetch(() =>
      new Response(JSON.stringify([{ id: 1, firstName: 'Kid' }]), { status: 200 }),
    );
    const client = new SchoolPassClient({ env, fetchImpl });
    const data = await client.get('parent/getstudents', { memberId: 5 });
    expect(data).toEqual([{ id: 1, firstName: 'Kid' }]);
    const { init, url } = dataCalls[0]!;
    expect(init.headers.AppCode).toBe('1183');
    expect(init.headers.Authorization).toMatch(/^Bearer /);
    expect(url).toContain('/api/parent/getstudents?memberId=5');
  });

  it('bootstraps the session exactly once for concurrent calls', async () => {
    const usersCalls = { n: 0 };
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('Auth/users')) {
        usersCalls.n += 1;
        return new Response(JSON.stringify([{ userId: 5, userType: 3 }]), { status: 200 });
      }
      if (url.includes('Auth/token')) {
        return new Response(JSON.stringify({ access_token: jwt(futureExp()), refresh_token: 'r' }), {
          status: 200,
        });
      }
      return new Response('[]', { status: 200 });
    };
    const client = new SchoolPassClient({ env, fetchImpl });
    await Promise.all([client.get('a'), client.get('b'), client.get('c')]);
    expect(usersCalls.n).toBe(1);
  });

  it('refreshes once and replays on a 401', async () => {
    let dataHits = 0;
    const { fetchImpl } = scriptedFetch(() => {
      dataHits += 1;
      // First data hit 401s; the replay after refresh succeeds.
      return dataHits === 1
        ? new Response('unauthorized', { status: 401 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = new SchoolPassClient({ env, fetchImpl });
    const data = await client.get('parent/profile');
    expect(data).toEqual({ ok: true });
    expect(dataHits).toBe(2);
  });

  it('exposes the authenticated identity', async () => {
    const { fetchImpl } = scriptedFetch(() => new Response('[]', { status: 200 }));
    const client = new SchoolPassClient({ env, fetchImpl });
    const id = await client.getIdentity();
    expect(id).toMatchObject({ userId: 5, userType: 3 });
    // A second ensureSession short-circuits on the existing token.
    expect(await client.getIdentity()).toBe(id);
  });

  it('stringifies a non-string (JSON) error body in the thrown message', async () => {
    const { fetchImpl } = scriptedFetch(() => new Response('{"error":"nope"}', { status: 500 }));
    const client = new SchoolPassClient({ env, fetchImpl });
    const err = await client.get('parent/profile').catch((e) => e);
    expect(err).toBeInstanceOf(SchoolPassApiError);
    expect(err.message).toContain('nope');
  });

  it('exposes the parent memberId from the identity', async () => {
    const { fetchImpl } = scriptedFetch(() => new Response('[]', { status: 200 }));
    const client = new SchoolPassClient({ env, fetchImpl });
    expect(await client.getMemberId()).toBe(5);
    // schoolCode is read twice — second read hits the cached config.
    expect(client.schoolCode).toBe(1183);
    expect(client.schoolCode).toBe(1183);
  });

  it('sends a POST body through the post() convenience', async () => {
    const { fetchImpl, dataCalls } = scriptedFetch(() => new Response('{"ok":1}', { status: 200 }));
    const client = new SchoolPassClient({ env, fetchImpl });
    await client.post('some/write', { a: 1 });
    expect(dataCalls[0]!.init.method).toBe('POST');
    expect(dataCalls[0]!.init.body).toBe('{"a":1}');
  });

  it('falls back to a full re-login when the refresh path is dead', async () => {
    let dataHits = 0;
    let usersHits = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.includes('Auth/users')) {
        usersHits += 1;
        return new Response(JSON.stringify([{ userId: 5, userType: 3 }]), { status: 200 });
      }
      if (url.includes('Auth/token/refresh')) {
        // Refresh token is dead → forces a full re-login.
        return new Response('expired', { status: 400 });
      }
      if (url.includes('Auth/token')) {
        return new Response(JSON.stringify({ access_token: jwt(futureExp()), refresh_token: 'r' }), {
          status: 200,
        });
      }
      dataHits += 1;
      return dataHits === 1
        ? new Response('unauthorized', { status: 401 })
        : new Response('{"ok":1}', { status: 200 });
    };
    const client = new SchoolPassClient({ env, fetchImpl });
    const data = await client.get('parent/profile');
    expect(data).toEqual({ ok: 1 });
    // Bootstrapped twice: the initial login and the fallback re-login.
    expect(usersHits).toBe(2);
  });

  it('throws SchoolPassApiError with a 403 hint for an admin-only route', async () => {
    const { fetchImpl } = scriptedFetch(() => new Response('forbidden', { status: 403 }));
    const client = new SchoolPassClient({ env, fetchImpl });
    const err = await client.get('SchoolInfo/GetAllSchoolInfo').catch((e) => e);
    expect(err).toBeInstanceOf(SchoolPassApiError);
    expect(err.status).toBe(403);
    // The remedy lives on `.hint` (the MCP boundary renders it into the text).
    expect(err.hint).toMatch(/not authorized/i);
  });
});

describe('SchoolPassClient.healthcheck', () => {
  it('reports reachable + authenticated with the identity', async () => {
    const { fetchImpl } = scriptedFetch(() => new Response('[]', { status: 200 }));
    // version probe returns a JSON string body
    const wrapped: FetchLike = async (url, init) =>
      url.includes('/version')
        ? new Response(JSON.stringify('Host:...,School:SprAPiServer 1183'), { status: 200 })
        : fetchImpl(url, init);
    const client = new SchoolPassClient({ env, fetchImpl: wrapped });
    const health = await client.healthcheck();
    expect(health.reachable).toBe(true);
    expect(health.authenticated).toBe(true);
    expect(health.identity).toMatchObject({ userId: 5, userType: 3 });
  });

  it('reports reachable but NOT authenticated when login fails', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('/version')) return new Response(JSON.stringify('ok'), { status: 200 });
      return new Response('nope', { status: 401 }); // Auth/users fails
    };
    const client = new SchoolPassClient({ env, fetchImpl });
    const health = await client.healthcheck();
    expect(health.reachable).toBe(true);
    expect(health.authenticated).toBe(false);
    expect(health.error).toBeTruthy();
  });

  it('reports NOT reachable when the version probe throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = new SchoolPassClient({ env, fetchImpl });
    const health = await client.healthcheck();
    expect(health.reachable).toBe(false);
    expect(health.authenticated).toBe(false);
  });
});
