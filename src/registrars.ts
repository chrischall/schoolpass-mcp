/**
 * The server's tool surface, in one list.
 *
 * Lives beside `index.ts` (not inside it) because `index.ts` boots a stdio
 * server at import time — importing it from a test would connect a transport.
 * Keeping the registrar list here lets `tests/index.test.ts` assert the REAL
 * roster against the same array the entry point uses, so the two can't drift.
 *
 * Order is cosmetic (it only sets registration order) but reads as the setup
 * story: prove you're connected, look at your students, then at their schedule,
 * then change it.
 *
 * The surface is parent-scoped. All tools are read-only except the single
 * `confirm`-gated write (`schoolpass_submit_dismissal_change`), whose body shape
 * is derived from the SchoolPass app's own request and returns a dry-run preview
 * unless `confirm: true`.
 */

import type { ToolRegistrar } from '@chrischall/mcp-utils';
import type { SchoolPassClient } from './client.js';
import { registerChangeTools } from './tools/changes.js';
import { registerDismissalTools } from './tools/dismissal.js';
import { registerParentTools } from './tools/parent.js';
import { registerSessionTools } from './tools/session.js';

export const TOOL_REGISTRARS: ToolRegistrar<SchoolPassClient>[] = [
  registerSessionTools,
  registerParentTools,
  registerDismissalTools,
  registerChangeTools,
];
