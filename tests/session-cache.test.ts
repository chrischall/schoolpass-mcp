import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  sessionCachePath,
  createSessionCache,
  tokenView,
  reportCacheWriteFailure,
  type CachedSession,
} from '../src/session-cache.js';
import type { SchoolPassConfig } from '../src/config.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'schoolpass-cache-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const config = (over: Partial<SchoolPassConfig> = {}): SchoolPassConfig =>
  ({
    email: 'parent@example.com',
    password: 'pw1',
    schoolCode: 1234,
    ...over,
  }) as SchoolPassConfig;

const on = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  MCP_DATA_DIR: dir,
  SCHOOLPASS_SESSION_CACHE: 'true',
  ...over,
});

const session = (over: Partial<CachedSession> = {}): CachedSession => ({
  identity: { userId: 77, userType: 2 } as CachedSession['identity'],
  tokens: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 3_600_000 },
  ...over,
});

const cacheFile = (d: string): string => join(d, '.schoolpass-mcp', 'session.json');

describe('sessionCachePath', () => {
  it('prefers MCP_DATA_DIR, the variable mcp-host injects', () => {
    expect(sessionCachePath({ MCP_DATA_DIR: '/data' })).toBe(
      '/data/.schoolpass-mcp/session.json',
    );
  });

  it('honours an explicit SCHOOLPASS_SESSION_FILE', () => {
    expect(
      sessionCachePath({ SCHOOLPASS_SESSION_FILE: '/tmp/x.json', MCP_DATA_DIR: '/data' }),
    ).toBe('/tmp/x.json');
  });

  it('ignores a sentinel override rather than making a relative ./null', () => {
    expect(sessionCachePath({ SCHOOLPASS_SESSION_FILE: 'null', HOME: '/home/u' })).toBe(
      '/home/u/.schoolpass-mcp/session.json',
    );
  });
});

describe('createSessionCache', () => {
  it('round-trips a full session through a 0600 file', () => {
    const p = createSessionCache(config(), on())!;
    p.save(session());
    expect(statSync(cacheFile(dir)).mode & 0o777).toBe(0o600);
    const back = createSessionCache(config(), on())!.load();
    expect(back?.identity.userId).toBe(77);
    expect(back?.tokens.accessToken).toBe('AT');
  });

  it.each([
    ['a rotated password', config({ password: 'pw2' })],
    ['a different parent', config({ email: 'other@example.com' })],
    ['a different school', config({ schoolCode: 9999 })],
  ])('discards the cache on %s', (_label, changed) => {
    createSessionCache(config(), on())!.save(session());
    expect(createSessionCache(changed, on())!.load()).toBeNull();
  });

  it('matches the email case-insensitively', () => {
    createSessionCache(config(), on())!.save(session());
    const cased = config({ email: '  Parent@Example.COM ' });
    expect(createSessionCache(cased, on())!.load()).not.toBeNull();
  });

  it('is disabled by SCHOOLPASS_SESSION_CACHE=false, and writes nothing', () => {
    expect(createSessionCache(config(), on({ SCHOOLPASS_SESSION_CACHE: 'false' }))).toBeNull();
    expect(existsSync(join(dir, '.schoolpass-mcp'))).toBe(false);
  });

  it('writes no credential material to disk', () => {
    createSessionCache(config(), on())!.save(session());
    const body = readFileSync(cacheFile(dir), 'utf8');
    expect(body).not.toContain('pw1');
    expect(body).not.toContain('parent@example.com');
  });
});

describe('both halves are required', () => {
  it.each([
    ['null', null],
    ['a primitive', 'nope'],
    ['no tokens', { identity: { userId: 1, userType: 2 } }],
    ['no identity', { tokens: { accessToken: 'AT', expiresAt: 1 } }],
    [
      'an identity with no userId',
      { identity: { userType: 2 }, tokens: { accessToken: 'AT', expiresAt: 1 } },
    ],
    [
      'a non-numeric userId',
      { identity: { userId: 'x', userType: 2 }, tokens: { accessToken: 'AT', expiresAt: 1 } },
    ],
    [
      'an empty accessToken',
      { identity: { userId: 1, userType: 2 }, tokens: { accessToken: '', expiresAt: 1 } },
    ],
    [
      'a non-numeric expiry',
      { identity: { userId: 1, userType: 2 }, tokens: { accessToken: 'AT', expiresAt: 'soon' } },
    ],
    [
      'a non-string refreshToken',
      {
        identity: { userId: 1, userType: 2 },
        tokens: { accessToken: 'AT', refreshToken: 7, expiresAt: 1 },
      },
    ],
  ])('rejects %s rather than restoring half a session', (_label, body) => {
    // The identity half matters as much as the tokens: getMemberId() reads
    // identity!.userId behind a non-null assertion, so a token-only record would
    // skip the login and then crash rather than degrade.
    const p = createSessionCache(config(), on())!;
    p.save(session());
    // Swap only the STATE, keeping the envelope's salted binding intact —
    // overwriting the whole file would be rejected by the binding check before
    // the shape guard ever ran, which is the wrong reason to pass.
    const envelope = JSON.parse(readFileSync(cacheFile(dir), 'utf8')) as { state: unknown };
    envelope.state = body;
    writeFileSync(cacheFile(dir), JSON.stringify(envelope), { mode: 0o600 });
    expect(createSessionCache(config(), on())!.load()).toBeNull();
  });
});

describe('tokenView', () => {
  it('keeps the identity attached when the manager persists a refresh', () => {
    // TokenManager only knows about BearerTokens. Without the view re-attaching
    // the identity, a refresh would overwrite the file with half a session and
    // the NEXT restart would fall back to a full login for no reason.
    const cache = createSessionCache(config(), on())!;
    cache.save(session());
    const view = tokenView(cache, { userId: 77, userType: 2 } as CachedSession['identity'])!;

    view.save({ accessToken: 'AT2', refreshToken: 'RT2', expiresAt: Date.now() + 7_200_000 });

    const back = createSessionCache(config(), on())!.load();
    expect(back?.tokens.accessToken).toBe('AT2');
    expect(back?.identity.userId).toBe(77);
  });

  it('reads back only the token half', () => {
    const cache = createSessionCache(config(), on())!;
    cache.save(session());
    const view = tokenView(cache, session().identity)!;
    expect(view.load()).toEqual(expect.objectContaining({ accessToken: 'AT' }));
  });

  it('returns null on an empty cache, and clears through to the file', () => {
    const cache = createSessionCache(config(), on())!;
    const view = tokenView(cache, session().identity)!;
    expect(view.load()).toBeNull();
    cache.save(session());
    view.clear();
    expect(cache.load()).toBeNull();
  });

  it('is null when there is no cache to view', () => {
    expect(tokenView(null, session().identity)).toBeNull();
  });
});

describe('reportCacheWriteFailure', () => {
  it.each([
    ['an Error', new Error('EROFS'), 'EROFS'],
    ['a non-Error', 'disk gone', 'disk gone'],
  ])('names the cause for %s and stays on stderr', (_label, thrown, expected) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      reportCacheWriteFailure(thrown);
      expect(err).toHaveBeenCalledWith(expect.stringContaining(expected as string));
      // stdout is the JSON-RPC channel; a stray write there corrupts the stream.
      expect(out).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });
});
