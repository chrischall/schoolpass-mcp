/**
 * Parent/family read tools: the parent's students, profile, and authorized
 * drivers. All read-only.
 *
 * Every endpoint here takes an optional `memberId` that defaults to the
 * signed-in parent's own id (from the auth identity), so the caller never has
 * to supply it. The response shapes below come from the API's Swagger spec and
 * are pinned by the live check (`scripts/live-check.mjs`).
 */

import { jsonResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ENDPOINTS } from '../protocol.js';
import type { SchoolPassClient } from '../client.js';

export function registerParentTools(server: McpServer, client: SchoolPassClient): void {
  server.registerTool(
    'schoolpass_list_students',
    {
      description:
        "List the students linked to the parent account: name, grade, home dismissal location, " +
        'aftercare flag, and per-student details. Defaults to the signed-in parent.',
      annotations: toolAnnotations({
        title: 'List students',
        readOnly: true,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: {},
    },
    async () => {
      const memberId = await client.getMemberId();
      const data = await client.get(ENDPOINTS.parentStudents, { memberId });
      return jsonResult(data);
    },
  );

  server.registerTool(
    'schoolpass_get_profile',
    {
      description:
        'Get the parent account profile (contact details and account settings) for the signed-in parent.',
      annotations: toolAnnotations({
        title: 'Parent profile',
        readOnly: true,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: {},
    },
    async () => {
      const memberId = await client.getMemberId();
      const data = await client.get(ENDPOINTS.parentProfile, { memberId });
      return jsonResult(data);
    },
  );

  server.registerTool(
    'schoolpass_list_drivers',
    {
      description:
        'List the authorized pickup drivers registered on the parent account, optionally including ' +
        'the carpools each belongs to.',
      annotations: toolAnnotations({
        title: 'List drivers',
        readOnly: true,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: {},
    },
    async () => {
      const memberId = await client.getMemberId();
      const data = await client.get(ENDPOINTS.parentDrivers, {
        memberId,
        includeCarpool: true,
      });
      return jsonResult(data);
    },
  );
}
