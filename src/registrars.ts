/**
 * The server's tool surface, in one list.
 *
 * Lives beside `index.ts` (not inside it) because `index.ts` boots a stdio
 * server at import time — importing it from a test would connect a transport.
 * Keeping the registrar list here lets `tests/index.test.ts` assert the REAL
 * roster against the same array the entry point uses, so the two can't drift.
 *
 * Order is cosmetic (it only sets registration order) but reads as the setup
 * story: prove you're connected, look at your students, then at their schedule.
 *
 * This surface is parent-scoped and read-only. The one meaningful parent write
 * — submitting an alternate pickup / dismissal change — is intentionally absent
 * until its request body is verified against a real successful change; it will
 * arrive as a `confirm`-gated tool with a dry-run preview.
 */

import type { ToolRegistrar } from '@chrischall/mcp-utils';
import type { SchoolPassClient } from './client.js';
import { registerDismissalTools } from './tools/dismissal.js';
import { registerParentTools } from './tools/parent.js';
import { registerSessionTools } from './tools/session.js';

export const TOOL_REGISTRARS: ToolRegistrar<SchoolPassClient>[] = [
  registerSessionTools,
  registerParentTools,
  registerDismissalTools,
];
