/**
 * Session / identity tools: a healthcheck that separates "can't reach the API"
 * from "credentials rejected", and a `whoami` that reports the parent identity
 * the server authenticated as.
 *
 * Both are read-only and take no `confirm` gate.
 *
 * **Neither takes `view`, and that is deliberate rather than an oversight in
 * the compact rollout.** Every other read tool here hands back a SchoolPass
 * payload whose shape nobody has captured, which is exactly what `view` exists
 * for. These two do not: their responses are assembled HERE from a fixed list
 * of named scalars — `reachable`/`authenticated`/`identity` and
 * `memberId`/`userType`/`name`/`email`. The one value that comes off the wire
 * is the healthcheck's `version`, a version string. So there is no unknown
 * field for a projection to reach and no image or avatar URL for compact to
 * strip: a `view` parameter here would advertise a choice that changes nothing,
 * on the two tools a caller reaches for when something is already wrong. (Same
 * call as `evite_healthcheck`, which takes no `view` for the same reason.)
 */

import { minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
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
    async () => minifiedResult(await client.healthcheck()),
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
      return minifiedResult({
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
