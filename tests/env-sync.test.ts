import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Every env var the server reads must be settable from each install path, and
 * none may be forced on an install: the server boots without credentials (the
 * config error is deferred to the first tool call so the install-time
 * tools/list probe answers), so nothing is required at the manifest level.
 */
const read = <T>(p: string): T => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')) as T;

const manifest = read<{
  server: { mcp_config: { env: Record<string, string> } };
  user_config: Record<string, { required?: boolean }>;
}>('manifest.json');
const serverJson = read<{
  packages: { environmentVariables: { name: string; isRequired?: boolean }[] }[];
}>('server.json');

const SERVER_READS = [
  'SCHOOLPASS_EMAIL',
  'SCHOOLPASS_PASSWORD',
  'SCHOOLPASS_SCHOOL_CODE',
  'SCHOOLPASS_API_HOST',
  'SCHOOLPASS_TIMEZONE',
  'SCHOOLPASS_SESSION_CACHE',
  'SCHOOLPASS_SESSION_FILE',
];

describe('manifest.json env', () => {
  it('wires every env var the server reads', () => {
    expect(Object.keys(manifest.server.mcp_config.env).sort()).toEqual([...SERVER_READS].sort());
  });

  it('marks no user_config entry required', () => {
    const required = Object.entries(manifest.user_config)
      .filter(([, c]) => c.required !== false)
      .map(([k]) => k);
    expect(required).toEqual([]);
  });
});

describe('server.json env', () => {
  const vars = serverJson.packages[0]!.environmentVariables;

  it('declares every env var the server reads', () => {
    expect(vars.map((v) => v.name).sort()).toEqual([...SERVER_READS].sort());
  });

  it('marks none of them required', () => {
    expect(vars.filter((v) => v.isRequired !== false).map((v) => v.name)).toEqual([]);
  });
});
