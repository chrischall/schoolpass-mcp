/**
 * Context-group hints, published on each tool as `_meta.mint` (mcp-host's
 * `mintHintSchema`, spec 2026-11-03 D4). Inert data: a host that does not read
 * them sees an extra `_meta` key and nothing else. The shape is fixed by the
 * host's contract, so it is restated here rather than imported — this server
 * takes no dependency on mcp-host.
 *
 * `subject` and `when` name THIS tool's own argument names (the host fills
 * them), never values; `aliases` are the words a person says — lowercase, at
 * most 8, each at most 40 chars.
 *
 * The healthcheck carries none: it joins no group (the host's `all` connector
 * only).
 */
export type MintIntent =
  | 'whats-new' | 'whats-due' | 'whats-on' | 'lookup' | 'turn-on-off' | 'send' | 'change' | 'other';

export interface MintHint {
  domain: 'school';
  intent: MintIntent;
  canonical?: true;
  subject?: string;
  when?: { start: string; end: string };
  aliases?: string[];
}

/** `_meta` for a SchoolPass tool: every tool here is in the `school` domain. */
export function schoolMeta(
  intent: MintIntent,
  extra: Omit<MintHint, 'domain' | 'intent'> = {},
): { mint: MintHint } {
  return { mint: { domain: 'school', intent, ...extra } };
}
