import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { TOOL_REGISTRARS } from '../src/registrars.js';
import { SchoolPassClient } from '../src/client.js';

/** The exact tool roster this server registers. Update deliberately. */
const EXPECTED_TOOLS = [
  'schoolpass_healthcheck',
  'schoolpass_whoami',
  'schoolpass_list_students',
  'schoolpass_get_profile',
  'schoolpass_list_drivers',
  'schoolpass_get_calendar',
  'schoolpass_list_pickup_changes',
  'schoolpass_list_dismissal_locations',
  'schoolpass_get_school_info',
].sort();

/** Apply every registrar with a no-credential client (registration does no I/O). */
async function harnessWithAllTools() {
  const client = new SchoolPassClient({ env: {} });
  return createTestHarness((server) => {
    for (const register of TOOL_REGISTRARS) register(server, client);
  });
}

describe('tool roster', () => {
  it('registers exactly the expected tools', async () => {
    const h = await harnessWithAllTools();
    const names = (await h.listTools()).map((t) => t.name).sort();
    expect(names).toEqual(EXPECTED_TOOLS);
    await h.close();
  });

  it('every registered tool has a non-empty description', async () => {
    const h = await harnessWithAllTools();
    const result = await h.client.listTools();
    for (const tool of result.tools) {
      expect(tool.description, `${tool.name} description`).toBeTruthy();
      expect((tool.description ?? '').length).toBeGreaterThan(20);
    }
    await h.close();
  });
});
