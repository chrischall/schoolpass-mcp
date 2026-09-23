import {
  createFileStatePersistence,
  resolveStateFile,
  type BearerTokens,
  type SyncStatePersistence,
} from '@chrischall/mcp-utils/session';
import { parseBoolEnv } from '@chrischall/mcp-utils';
import type { SchoolPassIdentity } from './auth.js';
import type { SchoolPassConfig } from './config.js';

/**
 * What a restart needs to skip the login — BOTH halves.
 *
 * Caching only the tokens would look right and then fail: `login()` also returns
 * the identity, and `getMemberId()` reads `this.identity!.userId` behind a
 * non-null assertion. A token-only restore would skip the login, leave identity
 * undefined, and crash on the first parent-scoped call rather than degrading.
 */
export interface CachedSession {
  identity: SchoolPassIdentity;
  tokens: BearerTokens;
}

/** Where the session is cached between runs. */
export function sessionCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveStateFile({
    env,
    envVar: 'SCHOOLPASS_SESSION_FILE',
    subdir: '.schoolpass-mcp',
    fileName: 'session.json',
  });
}

/** Guard both halves: a usable token pair AND a usable identity. */
function isCached(raw: unknown): raw is CachedSession {
  if (raw === null || typeof raw !== 'object') return false;
  const r = raw as Partial<CachedSession>;
  const t = r.tokens as Partial<BearerTokens> | undefined;
  if (t === null || typeof t !== 'object') return false;
  if (typeof t.accessToken !== 'string' || t.accessToken === '') return false;
  if (typeof t.expiresAt !== 'number') return false;
  if (t.refreshToken !== undefined && typeof t.refreshToken !== 'string') return false;
  const i = r.identity as Partial<SchoolPassIdentity> | undefined;
  if (i === null || typeof i !== 'object') return false;
  // userId is what getMemberId() dereferences, so it is the field that decides
  // whether a restored record is usable at all.
  return typeof i.userId === 'number' && typeof i.userType === 'number';
}

/**
 * The session cache, or `null` when disabled.
 *
 * Bound to the credentials AND the tenant: the school code is part of the
 * identity a session is scoped to, so the same login against a different school
 * must not reuse the old record. Only a salted digest is written.
 */
export function createSessionCache(
  config: SchoolPassConfig,
  env: NodeJS.ProcessEnv = process.env,
): SyncStatePersistence<CachedSession> | null {
  if (!parseBoolEnv('SCHOOLPASS_SESSION_CACHE', { env, default: true })) return null;

  return createFileStatePersistence<CachedSession>({
    filePath: sessionCachePath(env),
    boundTo: [
      String(config.schoolCode),
      config.email.trim().toLowerCase(),
      config.password,
      // Joined on a NUL, written as an escape rather than a literal byte, so a
      // different (school, email, password) triple cannot collide with this one
      // by shifting the boundaries between the parts.
    ].join('\u0000'),
    validate: (raw) => (isCached(raw) ? raw : null),
  });
}

/** Where the client keeps the identity half of its session. */
export interface IdentitySlot {
  get(): SchoolPassIdentity | undefined;
  set(identity: SchoolPassIdentity): void;
}

/**
 * A {@link SyncStatePersistence} over just the TOKEN half of a cached session,
 * for handing to `TokenManager`.
 *
 * The manager owns the token lifecycle: it reads this once, persists after every
 * login and refresh (which keeps the cached copy from going stale), and clears
 * it when a refresh token turns out to be revoked. It only knows about
 * `BearerTokens`, so the view carries the identity across: a load restores the
 * identity half into the client's slot, and a save re-attaches whatever identity
 * the client holds NOW — which, after a re-login, is the fresh one — so one file
 * always holds a complete, restorable session rather than half of one.
 */
export function tokenView(
  cache: SyncStatePersistence<CachedSession> | null,
  identity: IdentitySlot,
): SyncStatePersistence<BearerTokens> | undefined {
  if (cache === null) return undefined;
  return {
    load: () => {
      const rec = cache.load();
      if (rec === null) return null;
      identity.set(rec.identity);
      return rec.tokens;
    },
    save: (tokens) => {
      const id = identity.get();
      // Unreachable in practice (the login sets the identity before the manager
      // persists its tokens), but a token-only record would crash the restore
      // path's getMemberId(); refuse it rather than write half a session.
      if (id === undefined) {
        throw new Error('no identity to cache alongside the tokens');
      }
      cache.save({ identity: id, tokens });
    },
    clear: () => cache.clear(),
  };
}

/**
 * Report a cache write that failed. Not fatal: the session is re-mintable from
 * the credentials in the environment, so a lost write costs the next start a
 * login rather than access.
 *
 * stderr only; stdout is the JSON-RPC channel.
 */
export function reportCacheWriteFailure(err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(
    `[schoolpass-mcp] could not cache the session (${detail}); continuing without the ` +
      'cache — every restart will log in again until this is fixed.',
  );
}
