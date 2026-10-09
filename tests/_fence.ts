import type { CallToolResult } from '@modelcontextprotocol/server';
import { parseToolResult } from '@chrischall/mcp-utils/test';

/**
 * Parse a result fenced by `untrustedResult` (fleet-audit#894) back to the
 * payload the tool fenced: `data` when the envelope nested it (an array, or an
 * object with its own `note`), otherwise the object minus the two markers.
 * Throws if the result is NOT fenced, so a test reading through this also
 * proves the fence is there.
 */
export function parseFenced<T = any>(result: CallToolResult): T {
  const env = parseToolResult<Record<string, unknown>>(result);
  if (env?.untrusted_content !== true) throw new Error(`result is not fenced: ${JSON.stringify(env)}`);
  const { untrusted_content: _u, note: _n, ...rest } = env;
  return ('data' in rest && Object.keys(rest).length === 1 ? rest.data : rest) as T;
}
