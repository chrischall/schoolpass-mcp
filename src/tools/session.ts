/**
 * Session / identity tools: a healthcheck that separates "can't reach the API"
 * from "credentials rejected", and a `whoami` that reports the parent identity
 * the server authenticated as.
 *
 * Both are read-only and take no `confirm` gate.
 */

import { jsonResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { UserType } from '../protocol.js';
import type { SchoolPassClient } from '../client.js';

export function registerSessionTools(server: McpServer, client: SchoolPassClient): void {
  server.registerTool(
    'schoolpass_healthcheck',
    {
      description:
        'Check SchoolPass connectivity and authentication. Reports whether the regional API host is ' +
        'reachable (an unauthenticated version probe) and, separately, whether the configured ' +
        'credentials log in — so a network problem is distinguishable from a bad password or school code.',
      annotations: toolAnnotations({
        title: 'SchoolPass healthcheck',
        readOnly: true,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: {},
    },
    async () => jsonResult(await client.healthcheck()),
  );

  server.registerTool(
    'schoolpass_whoami',
    {
      description:
        'Return the parent account this server is signed in as: member id, user type, and name. ' +
        'Runs the login bootstrap if it has not run yet.',
      annotations: toolAnnotations({
        title: 'SchoolPass identity',
        readOnly: true,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: {},
    },
    async () => {
      const id = await client.getIdentity();
      return jsonResult({
        memberId: id.userId,
        userType: id.userType,
        userTypeName: UserType[id.userType] ?? String(id.userType),
        firstName: id.firstName,
        lastName: id.lastName,
        email: id.email,
        schoolCode: client.schoolCode,
      });
    },
  );
}
