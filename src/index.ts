#!/usr/bin/env node
/**
 * stdio entry point.
 *
 * `runMcp` builds the `McpServer`, writes the banner to **stderr** (stdout is
 * the JSON-RPC channel and nothing else may touch it), applies every registrar
 * with `client` threaded through as deps, wires SIGINT/SIGTERM shutdown, and
 * connects the stdio transport.
 *
 * The client is the singleton built in `client.ts`, never in a registrar —
 * which keeps the deferred-config-error pattern intact: `new SchoolPassClient()`
 * does no I/O and never throws, so the server boots and answers the host's
 * install-time `tools/list` probe with no credentials present. The configuration
 * error surfaces on the first tool call instead, where a human can read it.
 */

import { runMcp } from '@chrischall/mcp-utils';
import { client } from './client.js';
import { toolRegistrars } from './registrars.js';
import { loadStudentDirectory } from './students.js';
import { VERSION } from './version.js';

// The student reads' `student_id` publishes the parent's students as an enum of
// names (context groups, mcp-host spec 2026-11-03 D5), so list them ONCE here,
// bounded by STUDENT_LIST_TIMEOUT_MS. Null — not configured yet, a rejected
// login (latched by the client, so no second attempt), a timeout, no students —
// publishes the plain id.
const students = await loadStudentDirectory(client);

await runMcp({
  name: 'schoolpass-mcp',
  version: VERSION,
  banner:
    '[schoolpass-mcp] This project was developed and is maintained by AI. Use at your own discretion.',
  deps: client,
  tools: toolRegistrars(students),
});
