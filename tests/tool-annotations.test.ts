import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { TOOL_REGISTRARS } from '../src/registrars.js';
import { SchoolPassClient } from '../src/client.js';

/**
 * The fleet annotation meta-test, read off the ADVERTISED tool list (what a
 * client sees on the wire), not a hand-kept table.
 *
 * `destructiveHint` defaults to TRUE whenever `readOnlyHint` is false, so a
 * write that forgets to declare it publishes as destructive and nothing
 * fails — a considered `false` and a forgotten one look identical. The
 * invariant worth pinning is that every write CHOOSES.
 */
interface Ann {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  openWorldHint?: unknown;
}

async function advertisedAnnotations(): Promise<Record<string, Ann | undefined>> {
  const client = new SchoolPassClient({ env: {} });
  const h = await createTestHarness((server) => {
    for (const register of TOOL_REGISTRARS) register(server, client);
  });
  const { tools } = await h.client.listTools();
  await h.close();
  return Object.fromEntries(tools.map((t) => [t.name, t.annotations as Ann | undefined]));
}

describe('tool annotations', () => {
  it('covers the full surface (guards against a registrar being dropped)', async () => {
    expect(Object.keys(await advertisedAnnotations())).toHaveLength(11);
  });

  it('sets an explicit boolean readOnlyHint on every tool', async () => {
    const missing = Object.entries(await advertisedAnnotations())
      .filter(([, a]) => typeof a?.readOnlyHint !== 'boolean')
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('sets an explicit boolean destructiveHint on every write', async () => {
    const undeclared = Object.entries(await advertisedAnnotations())
      .filter(([, a]) => a?.readOnlyHint === false && typeof a?.destructiveHint !== 'boolean')
      .map(([name]) => name);
    expect(undeclared).toEqual([]);
  });

  it('never lets a read claim to be destructive', async () => {
    const contradictory = Object.entries(await advertisedAnnotations())
      .filter(([, a]) => a?.readOnlyHint === true && a?.destructiveHint === true)
      .map(([name]) => name);
    expect(contradictory).toEqual([]);
  });

  it('marks every tool openWorld (each one talks to the SchoolPass API)', async () => {
    const closed = Object.entries(await advertisedAnnotations())
      .filter(([, a]) => a?.openWorldHint !== true)
      .map(([name]) => name);
    expect(closed).toEqual([]);
  });

  it('holds the write set at exactly the two confirm-gated dismissal tools', async () => {
    // Both reach the school (a submitted change lands in front of dismissal
    // staff; a cancel deletes a child's real arrangement), so neither has an
    // inverse that can un-notify anyone: both stay destructive.
    const writes = Object.entries(await advertisedAnnotations())
      .filter(([, a]) => a?.readOnlyHint === false)
      .map(([name, a]) => [name, a?.destructiveHint]);
    expect(writes.sort()).toEqual([
      ['schoolpass_cancel_dismissal_change', true],
      ['schoolpass_submit_dismissal_change', true],
    ]);
  });
});
