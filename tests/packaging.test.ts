/**
 * Packaging guards that otherwise only fail once a git tag exists.
 *
 *  - `repository.url` must be present and correct, or `npm publish --provenance`
 *    rejects the whole publish with E422 AFTER release-please has already tagged
 *    and cut the GitHub Release — so npm silently never moves. (thumbtack v0.1.0.)
 *  - `files` must include `skills`, or a new skill silently would not ship.
 *  - The `manifest.json` tool roster is not asserted here (the tools are not
 *    listed in manifest.json), but the entry point + node floor are.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = <T>(p: string): T => JSON.parse(readFileSync(join(ROOT, p), 'utf8')) as T;

describe('package.json publish shape', () => {
  const pkg = readJson<{
    name: string;
    repository?: { type?: string; url?: string };
    files?: string[];
    bin?: Record<string, string>;
    engines?: { node?: string };
  }>('package.json');

  it('declares the git repository (required for provenance publish)', () => {
    expect(pkg.repository?.url).toBe('git+https://github.com/chrischall/schoolpass-mcp.git');
  });

  it('ships dist, skills, and the registry manifests', () => {
    for (const f of ['dist', 'skills', 'server.json', '.claude-plugin']) {
      expect(pkg.files, `files should include ${f}`).toContain(f);
    }
  });

  it('bin points at the tsc entry point (dist/index.js)', () => {
    expect(pkg.bin?.['schoolpass-mcp']).toBe('dist/index.js');
  });
});

describe('manifest.json', () => {
  const manifest = readJson<{
    server: { entry_point: string };
    compatibility: { runtimes: { node: string } };
  }>('manifest.json');

  it('entry point is the self-contained bundle', () => {
    expect(manifest.server.entry_point).toBe('dist/bundle.js');
  });

  it('node runtime floor stays on an LTS (>=22.x), not 26', () => {
    expect(manifest.compatibility.runtimes.node).toMatch(/^>=22\./);
  });
});
