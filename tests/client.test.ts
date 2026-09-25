import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchoolPassClient } from '../src/client.js';
import { SchoolPassApiError, type FetchLike } from '../src/protocol.js';
import { SchoolPassConfigError, resolveConfig } from '../src/config.js';
import { createSessionCache, type CachedSession } from '../src/session-cache.js';

const env = {
  // Off by default here as well as in tests/_setup.ts: the client reads the
  // INJECTED env, so the process.env guard in the setup file does not reach it.
  SCHOOLPASS_SESSION_CACHE: 'false',
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

  it('submitStudentChange attaches modifiedBy + parentMemberId (the parent id)', async () => {
    const { fetchImpl, dataCalls } = scriptedFetch(() => new Response('{"ok":1}', { status: 200 }));
    const client = new SchoolPassClient({ env, fetchImpl });
    await client.submitStudentChange({ studentId: 11278, changeType: 4 });
    const { url, init } = dataCalls[0]!;
    expect(url).toContain('/api/studentchange?');
    expect(url).toContain('schoolCode=1183');
    expect(url).toContain('parentMemberId=5');
    expect(JSON.parse(init.body as string)).toMatchObject({ studentId: 11278, changeType: 4, modifiedBy: 5 });
  });

  it('deleteStudentChange issues a DELETE with the change series query', async () => {
    const { fetchImpl, dataCalls } = scriptedFetch(() => new Response('{"ok":1}', { status: 200 }));
    const client = new SchoolPassClient({ env, fetchImpl });
    await client.deleteStudentChange({ changeSeriesId: 27074, changeType: 1, adType: 4, date: '2026-09-14' });
    const { url, init } = dataCalls[0]!;
    expect(init.method).toBe('DELETE');
    expect(url).toContain('/api/studentchange/DeleteMobileChange?');
    expect(url).toContain('ChangeSeriesId=27074');
    expect(url).toContain('ADType=4');
    expect(url).toContain('dt=2026-09-14');
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

describe('SchoolPassClient — session cache write failure', () => {
  it('reports a failed cache write and still serves the request', async () => {
    // A read-only or unwritable data dir must cost the NEXT start a login, not
    // this request. Point the cache at a path whose parent is a file so every
    // write fails.
    const dir = mkdtempSync(join(tmpdir(), 'schoolpass-ro-'));
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    // Through the INJECTED env, not process.env: the client reads the env it
    // was handed, so setting the ambient one would leave the cache disabled and
    // the test would pass without ever reaching the write it claims to cover.
    const cacheEnv = {
      ...env,
      SCHOOLPASS_SESSION_CACHE: 'true',
      SCHOOLPASS_SESSION_FILE: join(blocker, 'session.json'),
    };
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { fetchImpl } = scriptedFetch(() => new Response('{"ok":true}', { status: 200 }));
      const client = new SchoolPassClient({ fetchImpl, env: cacheEnv });
      await expect(client.getMemberId()).resolves.toBeTypeOf('number');
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not cache/i));
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SchoolPassClient — session cache hit', () => {
  /** A fetch that counts logins, so "did it skip the login" is observable. */
  function countingFetch(): { fetchImpl: FetchLike; logins: () => number } {
    let logins = 0;
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('Auth/users')) {
        logins += 1;
        return new Response(JSON.stringify([{ userId: 5, userType: 3 }]), { status: 200 });
      }
      if (url.includes('Auth/token')) {
        return new Response(
          JSON.stringify({ access_token: jwt(futureExp()), refresh_token: 'r1' }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify([{ id: 1 }]), { status: 200 });
    };
    return { fetchImpl, logins: () => logins };
  }

  it('a second process restores the session and does not log in again', async () => {
    // The whole point of the feature, asserted end to end rather than only
    // through the cache module: the first client logs in and writes, the second
    // reads that file and skips the login entirely.
    const dir = mkdtempSync(join(tmpdir(), 'schoolpass-hit-'));
    try {
      const cacheEnv = {
        ...env,
        SCHOOLPASS_SESSION_CACHE: 'true',
        SCHOOLPASS_SESSION_FILE: join(dir, 'session.json'),
      };

      const first = countingFetch();
      const a = new SchoolPassClient({ fetchImpl: first.fetchImpl, env: cacheEnv });
      expect(await a.getMemberId()).toBe(5);
      expect(first.logins()).toBe(1);

      // A fresh client is a fresh process for these purposes.
      const second = countingFetch();
      const b = new SchoolPassClient({ fetchImpl: second.fetchImpl, env: cacheEnv });
      expect(await b.getMemberId()).toBe(5);
      expect(second.logins()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restores the identity, not just the tokens', async () => {
    // getMemberId() dereferences identity behind a non-null assertion, so a
    // half-restored session would throw here rather than degrade.
    const dir = mkdtempSync(join(tmpdir(), 'schoolpass-hit2-'));
    try {
      const cacheEnv = {
        ...env,
        SCHOOLPASS_SESSION_CACHE: 'true',
        SCHOOLPASS_SESSION_FILE: join(dir, 'session.json'),
      };
      const first = countingFetch();
      await new SchoolPassClient({ fetchImpl: first.fetchImpl, env: cacheEnv }).getMemberId();

      const second = countingFetch();
      const b = new SchoolPassClient({ fetchImpl: second.fetchImpl, env: cacheEnv });
      await expect(b.getMemberId()).resolves.toBe(5);
      expect(second.logins()).toBe(0);
      // The email is not persisted (fleet-audit#1106); a restored identity
      // reports the configured login email instead of losing it.
      expect((await b.getIdentity()).email).toBe(env.SCHOOLPASS_EMAIL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honours the INJECTED env, not the ambient one', async () => {
    // The bug this covers: createSessionCache read process.env instead of the
    // client's injected env, so a caller could not turn the cache off — and the
    // suite was disabling it through a channel the client never consulted.
    const dir = mkdtempSync(join(tmpdir(), 'schoolpass-env-'));
    const prev = process.env.SCHOOLPASS_SESSION_CACHE;
    try {
      // Ambient says ON; the injected env says OFF. The injected one must win,
      // so the second client logs in again.
      process.env.SCHOOLPASS_SESSION_CACHE = 'true';
      const cacheEnv = {
        ...env,
        SCHOOLPASS_SESSION_CACHE: 'false',
        SCHOOLPASS_SESSION_FILE: join(dir, 'session.json'),
      };
      const first = countingFetch();
      await new SchoolPassClient({ fetchImpl: first.fetchImpl, env: cacheEnv }).getMemberId();
      const second = countingFetch();
      await new SchoolPassClient({ fetchImpl: second.fetchImpl, env: cacheEnv }).getMemberId();
      expect(second.logins()).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.SCHOOLPASS_SESSION_CACHE;
      else process.env.SCHOOLPASS_SESSION_CACHE = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SchoolPassClient — dead refresh token with a cached session', () => {
  // fleet-audit#14: a cached record whose refresh token has died must be
  // discarded and replaced by a full login — not replayed forever (and across
  // restarts) until someone deletes session.json by hand.

  /** Seed the cache with a session whose refresh token the server rejects. */
  function seed(cacheEnv: NodeJS.ProcessEnv, expiresAt: number): void {
    createSessionCache(resolveConfig(cacheEnv), cacheEnv)!.save({
      identity: { userId: 5, userType: 3 } as CachedSession['identity'],
      tokens: { accessToken: jwt(Math.floor(expiresAt / 1000)), refreshToken: 'dead-refresh', expiresAt },
    });
  }

  /**
   * Login mints `fresh-<n>`-bearing JWTs; refresh answers `refreshStatus`; data
   * calls succeed only for a token minted by a login in THIS process.
   */
  function server(refreshStatus: number) {
    const minted = new Set<string>();
    let logins = 0;
    let refreshes = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.includes('Auth/users')) {
        logins += 1;
        return new Response(JSON.stringify([{ userId: 5, userType: 3 }]), { status: 200 });
      }
      if (url.includes('Auth/token/refresh')) {
        refreshes += 1;
        return new Response('refresh token expired', { status: refreshStatus });
      }
      if (url.includes('Auth/token')) {
        const token = `${jwt(futureExp())}.${logins}`;
        minted.add(token);
        return new Response(JSON.stringify({ access_token: token, refresh_token: 'r-new' }), {
          status: 200,
        });
      }
      const auth = String(init.headers.Authorization ?? '').replace(/^Bearer /, '');
      return minted.has(auth)
        ? new Response('{"ok":1}', { status: 200 })
        : new Response('unauthorized', { status: 401 });
    };
    return { fetchImpl, logins: () => logins, refreshes: () => refreshes };
  }

  function withCacheDir(fn: (cacheEnv: NodeJS.ProcessEnv) => Promise<void>) {
    return async () => {
      const dir = mkdtempSync(join(tmpdir(), 'schoolpass-dead-'));
      try {
        await fn({
          ...env,
          SCHOOLPASS_SESSION_CACHE: 'true',
          SCHOOLPASS_SESSION_FILE: join(dir, 'session.json'),
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
  }

  it(
    'proactive path: an expired cached token + dead refresh re-logs in and re-caches',
    withCacheDir(async (cacheEnv) => {
      seed(cacheEnv, Date.now() - 60_000);
      const s = server(400);
      const client = new SchoolPassClient({ env: cacheEnv, fetchImpl: s.fetchImpl });
      await expect(client.get('parent/profile')).resolves.toEqual({ ok: 1 });
      expect(s.logins()).toBe(1);

      // The dead record was replaced, so a restart does not inherit it.
      const cached = createSessionCache(resolveConfig(cacheEnv), cacheEnv)!.load();
      expect(cached?.tokens.refreshToken).toBe('r-new');
      expect(cached?.identity.userId).toBe(5);

      const restarted = new SchoolPassClient({ env: cacheEnv, fetchImpl: s.fetchImpl });
      await expect(restarted.get('parent/profile')).resolves.toEqual({ ok: 1 });
      expect(s.logins()).toBe(1);
    }),
  );

  it(
    'reactive path: a 401 on the cached token + dead refresh re-logs in instead of replaying the dead record',
    withCacheDir(async (cacheEnv) => {
      // Not expired locally, but the server no longer honours it.
      seed(cacheEnv, Date.now() + 3_600_000);
      const cache = createSessionCache(resolveConfig(cacheEnv), cacheEnv)!;

      const s = server(400);
      const client = new SchoolPassClient({ env: cacheEnv, fetchImpl: s.fetchImpl });
      await expect(client.get('parent/profile')).resolves.toEqual({ ok: 1 });
      expect(s.logins()).toBe(1);
      expect(cache.load()?.tokens.refreshToken).toBe('r-new');

      // And the NEXT call in the same process keeps working.
      await expect(client.get('parent/profile')).resolves.toEqual({ ok: 1 });
      expect(s.logins()).toBe(1);
    }),
  );

  it(
    'a restored expired access token + good refresh token refreshes with the stored access token — no login',
    withCacheDir(async (cacheEnv) => {
      // The ordinary cold start (mcp-host idles children out): the cached access
      // token has expired but the refresh token is still good. The refresh
      // contract is {schoolCode, access_token, refresh_token}, so the stored
      // access token must ride along — an empty one gets the refresh rejected
      // and throws away a good session for a reCAPTCHA-fronted login.
      const expiresAt = Date.now() - 60_000;
      const storedAccess = jwt(Math.floor(expiresAt / 1000));
      createSessionCache(resolveConfig(cacheEnv), cacheEnv)!.save({
        identity: { userId: 5, userType: 3 } as CachedSession['identity'],
        tokens: { accessToken: storedAccess, refreshToken: 'good-refresh', expiresAt },
      });

      let logins = 0;
      const refreshBodies: Array<Record<string, unknown>> = [];
      const refreshed = `${jwt(futureExp())}.refreshed`;
      const fetchImpl: FetchLike = async (url, init) => {
        if (url.includes('Auth/users')) {
          logins += 1;
          return new Response(JSON.stringify([{ userId: 5, userType: 3 }]), { status: 200 });
        }
        if (url.includes('Auth/token/refresh')) {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          refreshBodies.push(body);
          return body.access_token === storedAccess && body.refresh_token === 'good-refresh'
            ? new Response(JSON.stringify({ access_token: refreshed, refresh_token: 'r2' }), {
                status: 200,
              })
            : new Response('invalid token pair', { status: 400 });
        }
        if (url.includes('Auth/token')) {
          return new Response(
            JSON.stringify({ access_token: `${jwt(futureExp())}.login`, refresh_token: 'r-login' }),
            { status: 200 },
          );
        }
        const auth = String(init.headers.Authorization ?? '').replace(/^Bearer /, '');
        return auth === refreshed
          ? new Response('{"ok":1}', { status: 200 })
          : new Response('unauthorized', { status: 401 });
      };

      const client = new SchoolPassClient({ env: cacheEnv, fetchImpl });
      await expect(client.get('parent/profile')).resolves.toEqual({ ok: 1 });
      expect(logins).toBe(0);
      expect(refreshBodies).toHaveLength(1);
      expect(refreshBodies[0]?.access_token).toBe(storedAccess);
      const cached = createSessionCache(resolveConfig(cacheEnv), cacheEnv)!.load();
      expect(cached?.tokens.refreshToken).toBe('r2');
    }),
  );

  it(
    'a transient refresh outage (503) does not destroy the cached refresh token',
    withCacheDir(async (cacheEnv) => {
      seed(cacheEnv, Date.now() - 60_000);
      const s = server(503);
      const client = new SchoolPassClient({ env: cacheEnv, fetchImpl: s.fetchImpl });
      await expect(client.get('parent/profile')).rejects.toThrow(/503/);
      expect(s.logins()).toBe(0);
      const cached = createSessionCache(resolveConfig(cacheEnv), cacheEnv)!.load();
      expect(cached?.tokens.refreshToken).toBe('dead-refresh');
    }),
  );
});

describe('SchoolPassClient — rejected credential latch (fleet-audit#959)', () => {
  // SchoolPass fronts its login with reCAPTCHA. A rejected password must be
  // sent ONCE per process — not again on every later tool call, healthcheck
  // poll, or model retry after "check your password".

  /** Auth/users answers `usersStatus`; counts every login attempt. */
  function rejectingServer(usersStatus = 401) {
    let attempts = 0;
    let status = usersStatus;
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('/version')) return new Response(JSON.stringify('ok'), { status: 200 });
      if (url.includes('Auth/users')) {
        attempts += 1;
        return status === 200
          ? new Response(JSON.stringify([{ userId: 5, userType: 3 }]), { status: 200 })
          : new Response('invalid credentials', { status });
      }
      if (url.includes('Auth/token')) {
        return new Response(JSON.stringify({ access_token: jwt(futureExp()), refresh_token: 'r1' }), { status: 200 });
      }
      return new Response('{"ok":1}', { status: 200 });
    };
    return { fetchImpl, attempts: () => attempts, setStatus: (s: number) => (status = s) };
  }

  it('does not re-send a rejected password on later calls', async () => {
    const s = rejectingServer(401);
    const client = new SchoolPassClient({ env, fetchImpl: s.fetchImpl });
    const first = await client.get('parent/profile').catch((e: unknown) => e);
    const second = await client.get('parent/profile').catch((e: unknown) => e);
    const third = await client.get('parent/students').catch((e: unknown) => e);
    expect(s.attempts()).toBe(1);
    expect((first as Error).message).toMatch(/rejected/);
    // The SAME rejection is rethrown, hint and all.
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('a 400 latches too', async () => {
    const s = rejectingServer(400);
    const client = new SchoolPassClient({ env, fetchImpl: s.fetchImpl });
    await client.get('parent/profile').catch(() => undefined);
    await client.get('parent/profile').catch(() => undefined);
    expect(s.attempts()).toBe(1);
  });

  it('the healthcheck does not re-send it either', async () => {
    const s = rejectingServer(401);
    const client = new SchoolPassClient({ env, fetchImpl: s.fetchImpl });
    const h1 = await client.healthcheck();
    const h2 = await client.healthcheck();
    expect(h1.authenticated).toBe(false);
    expect(h2.authenticated).toBe(false);
    expect(h2.error).toMatch(/rejected/);
    expect(s.attempts()).toBe(1);
  });

  it('does NOT latch a transient upstream failure (5xx) — that may be retried', async () => {
    const s = rejectingServer(503);
    const client = new SchoolPassClient({ env, fetchImpl: s.fetchImpl });
    await client.get('parent/profile').catch(() => undefined);
    s.setStatus(200);
    await expect(client.get('parent/profile')).resolves.toEqual({ ok: 1 });
    expect(s.attempts()).toBe(2);
  });

  it('clears when the configured credentials change', async () => {
    const s = rejectingServer(401);
    const liveEnv: NodeJS.ProcessEnv = { ...env };
    const client = new SchoolPassClient({ env: liveEnv, fetchImpl: s.fetchImpl });
    await client.get('parent/profile').catch(() => undefined);
    s.setStatus(200);
    // Same credentials: still latched, no new attempt.
    await expect(client.get('parent/profile')).rejects.toThrow(/rejected/);
    expect(s.attempts()).toBe(1);
    // The user fixes the password: one fresh attempt, which succeeds.
    liveEnv.SCHOOLPASS_PASSWORD = 'corrected';
    await expect(client.get('parent/profile')).resolves.toEqual({ ok: 1 });
    expect(s.attempts()).toBe(2);
  });

  it('stays latched — no attempt, no config error — when the credentials are then removed', async () => {
    const s = rejectingServer(401);
    const liveEnv: NodeJS.ProcessEnv = { ...env };
    const client = new SchoolPassClient({ env: liveEnv, fetchImpl: s.fetchImpl });
    const first = await client.get('parent/profile').catch((e: unknown) => e);
    // Unset mid-edit is not "changed": the rejection stands until a complete,
    // different set of credentials is configured.
    delete liveEnv.SCHOOLPASS_PASSWORD;
    const second = await client.get('parent/profile').catch((e: unknown) => e);
    expect(second).toBe(first);
    expect(s.attempts()).toBe(1);
  });

  it('latches a rejection met on the dead-refresh-token fallback, and that fallback honours it too', async () => {
    // Log in fine, then the server revokes everything: the access token gets a
    // 401, the refresh token is dead, and the password has been changed.
    let usersStatus = 200;
    let attempts = 0;
    let dataStatus = 200;
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('Auth/users')) {
        attempts += 1;
        return usersStatus === 200
          ? new Response(JSON.stringify([{ userId: 5, userType: 3 }]), { status: 200 })
          : new Response('invalid credentials', { status: usersStatus });
      }
      if (url.includes('Auth/token/refresh')) return new Response('refresh token expired', { status: 400 });
      if (url.includes('Auth/token')) {
        return new Response(JSON.stringify({ access_token: jwt(futureExp()), refresh_token: 'r1' }), { status: 200 });
      }
      return dataStatus === 200 ? new Response('{"ok":1}', { status: 200 }) : new Response('unauthorized', { status: 401 });
    };
    const client = new SchoolPassClient({ env, fetchImpl });
    await expect(client.get('parent/profile')).resolves.toEqual({ ok: 1 });
    expect(attempts).toBe(1);

    usersStatus = 401;
    dataStatus = 401;
    // 401 -> refresh (dead) -> the manager falls back to the login -> rejected.
    const rejected = await client.get('parent/profile').catch((e: unknown) => e);
    expect((rejected as Error).message).toMatch(/rejected/);
    expect(attempts).toBe(2);

    // The next tool call is stopped by the latch in ensureSession().
    await expect(client.get('parent/profile')).rejects.toBe(rejected);
    // A caller that had already passed that check when the latch was set goes
    // straight to the manager, whose login fallback must refuse as well. This
    // drives it directly: the interleaving that reaches it is a microtask race
    // no test can schedule reliably.
    const manager = (client as unknown as { tokens: { getAccessToken(): Promise<string> } }).tokens;
    await expect(manager.getAccessToken()).rejects.toBe(rejected);
    expect(attempts).toBe(2);
  });
});
