// Suite-wide guard: no test may touch the developer's real session cache.
//
// `createSessionCache` resolves its path from MCP_DATA_DIR/HOME, so any test
// with SCHOOLPASS_EMAIL + SCHOOLPASS_PASSWORD set would read and write
// ~/.schoolpass-mcp/session.json — non-hermetic, order-dependent, and able to
// leave a real file behind.
//
// Written before the cache module exists, on purpose: in three earlier repos in
// this rollout the guard was added AFTER the first run, and each of those runs
// created a real file under $HOME.
//
// Two independent guards, deliberately belt-and-braces:
//   1. The cache is OFF by default, so the ordinary suite never constructs one.
//   2. The path is pinned into a temp dir anyway, so a test that turns the cache
//      ON to exercise it still cannot reach $HOME.
import { beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const CACHE_DIR = mkdtempSync(join(tmpdir(), 'schoolpass-test-cache-'));

beforeEach(() => {
  process.env.SCHOOLPASS_SESSION_CACHE = 'false';
  process.env.SCHOOLPASS_SESSION_FILE = join(CACHE_DIR, 'session.json');
});

afterAll(() => {
  rmSync(CACHE_DIR, { recursive: true, force: true });

  // The tripwire, and the reason it exists: the two guards above both work
  // through process.env, and a client that reads an INJECTED env bypasses them
  // completely — `resolveStateFile` then falls back to os.homedir(), which no
  // environment variable can redirect. That is not hypothetical; fixing the env
  // plumbing in this client is exactly what created a real file here.
  //
  // So assert the outcome rather than the mechanism: if anything reached the
  // developer's home directory, fail loudly instead of leaving it behind.
  const leaked = join(homedir(), '.schoolpass-mcp');
  if (existsSync(leaked)) {
    throw new Error(
      `A test wrote to ${leaked}. The suite must never touch the real home ` +
        'directory — inject SCHOOLPASS_SESSION_CACHE=false (or a temp ' +
        'SCHOOLPASS_SESSION_FILE) into the env that test hands the client.',
    );
  }
});
