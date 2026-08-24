import { describe, expect, it } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import type { SchoolPassClient } from '../src/client.js';
import { registerSessionTools } from '../src/tools/session.js';
import { registerParentTools } from '../src/tools/parent.js';
import { registerDismissalTools } from '../src/tools/dismissal.js';

interface GetCall {
  path: string;
  query?: Record<string, unknown>;
}

/** A fake client recording `get` calls and returning a canned body. */
function fakeClient(overrides: Partial<Record<string, unknown>> = {}): {
  client: SchoolPassClient;
  gets: GetCall[];
} {
  const gets: GetCall[] = [];
  const client = {
    schoolCode: 1183,
    async getMemberId() {
      return 5;
    },
    async getIdentity() {
      return { userId: 5, userType: 3, firstName: 'Pat', lastName: 'Guardian', email: 'p@x.com', raw: {} };
    },
    async healthcheck() {
      return { reachable: true, version: 'v', authenticated: true, identity: { userId: 5, userType: 3 } };
    },
    async get(path: string, query?: Record<string, unknown>) {
      gets.push({ path, query });
      return (overrides[path] as unknown) ?? { called: path };
    },
  } as unknown as SchoolPassClient;
  return { client, gets };
}

describe('session tools', () => {
  it('healthcheck returns the client health', async () => {
    const { client } = fakeClient();
    const h = await createTestHarness((s) => registerSessionTools(s, client));
    const res = parseToolResult<{ authenticated: boolean }>(await h.callTool('schoolpass_healthcheck'));
    expect(res.authenticated).toBe(true);
    await h.close();
  });

  it('whoami reports the identity with a resolved user type name', async () => {
    const { client } = fakeClient();
    const h = await createTestHarness((s) => registerSessionTools(s, client));
    const res = parseToolResult<{ userTypeName: string; memberId: number }>(
      await h.callTool('schoolpass_whoami'),
    );
    expect(res).toMatchObject({ memberId: 5, userTypeName: 'Parent', schoolCode: 1183 });
    await h.close();
  });

  it('whoami falls back to the numeric type for an unknown user type', async () => {
    const client = {
      schoolCode: 1183,
      async getIdentity() {
        return { userId: 5, userType: 99, raw: {} };
      },
    } as unknown as SchoolPassClient;
    const h = await createTestHarness((s) => registerSessionTools(s, client));
    const res = parseToolResult<{ userTypeName: string }>(await h.callTool('schoolpass_whoami'));
    expect(res.userTypeName).toBe('99');
    await h.close();
  });
});

describe('parent tools', () => {
  it('list_students calls parent/getstudents with the parent memberId', async () => {
    const { client, gets } = fakeClient({ 'parent/getstudents': [{ id: 1 }] });
    const h = await createTestHarness((s) => registerParentTools(s, client));
    const res = parseToolResult(await h.callTool('schoolpass_list_students'));
    expect(res).toEqual([{ id: 1 }]);
    expect(gets[0]).toEqual({ path: 'parent/getstudents', query: { memberId: 5 } });
    await h.close();
  });

  it('list_drivers requests carpool membership', async () => {
    const { client, gets } = fakeClient();
    const h = await createTestHarness((s) => registerParentTools(s, client));
    await h.callTool('schoolpass_list_drivers');
    expect(gets[0]!.query).toMatchObject({ memberId: 5, includeCarpool: true });
    await h.close();
  });

  it('get_profile calls parent/profile with the parent memberId', async () => {
    const { client, gets } = fakeClient({ 'parent/profile': { name: 'Pat' } });
    const h = await createTestHarness((s) => registerParentTools(s, client));
    const res = parseToolResult(await h.callTool('schoolpass_get_profile'));
    expect(res).toEqual({ name: 'Pat' });
    expect(gets[0]).toEqual({ path: 'parent/profile', query: { memberId: 5 } });
    await h.close();
  });
});

describe('dismissal tools', () => {
  it('get_calendar defaults the date range and passes the student id', async () => {
    const { client, gets } = fakeClient();
    const h = await createTestHarness((s) => registerDismissalTools(s, client));
    await h.callTool('schoolpass_get_calendar', { student_id: 42 });
    const q = gets[0]!.query!;
    expect(q).toMatchObject({ schoolCode: 1183, studentId: 42 });
    expect(String(q.startDate)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(String(q.endDate)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await h.close();
  });

  it('get_calendar rejects a non-positive student id', async () => {
    const { client } = fakeClient();
    const h = await createTestHarness((s) => registerDismissalTools(s, client));
    const res = await h.callTool('schoolpass_get_calendar', { student_id: 0 });
    expect(res.isError).toBe(true);
    await h.close();
  });

  it('list_pickup_changes defaults date to today and passes the student id', async () => {
    const { client, gets } = fakeClient();
    const h = await createTestHarness((s) => registerDismissalTools(s, client));
    await h.callTool('schoolpass_list_pickup_changes', { student_id: 42 });
    expect(gets[0]!.query).toMatchObject({ studentId: 42 });
    expect(String(gets[0]!.query!.date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await h.close();
  });

  it('list_dismissal_locations fetches the dismissal locations', async () => {
    const { client, gets } = fakeClient({
      'dismissal/getDismissalLocations': [{ id: 1, name: 'Car Line' }],
    });
    const h = await createTestHarness((s) => registerDismissalTools(s, client));
    const res = parseToolResult(await h.callTool('schoolpass_list_dismissal_locations'));
    expect(res).toEqual([{ id: 1, name: 'Car Line' }]);
    expect(gets[0]!.path).toBe('dismissal/getDismissalLocations');
    await h.close();
  });

  it('get_calendar honors explicit start and end dates', async () => {
    const { client, gets } = fakeClient();
    const h = await createTestHarness((s) => registerDismissalTools(s, client));
    await h.callTool('schoolpass_get_calendar', {
      student_id: 42,
      start_date: '2026-01-01',
      end_date: '2026-01-31',
    });
    expect(gets[0]!.query).toMatchObject({ startDate: '2026-01-01', endDate: '2026-01-31' });
    await h.close();
  });

  it('list_pickup_changes honors an explicit date', async () => {
    const { client, gets } = fakeClient();
    const h = await createTestHarness((s) => registerDismissalTools(s, client));
    await h.callTool('schoolpass_list_pickup_changes', { student_id: 42, date: '2026-02-02' });
    expect(gets[0]!.query).toMatchObject({ date: '2026-02-02' });
    await h.close();
  });

  it('get_school_info fetches both basic info and config', async () => {
    const { client, gets } = fakeClient();
    const h = await createTestHarness((s) => registerDismissalTools(s, client));
    await h.callTool('schoolpass_get_school_info');
    const paths = gets.map((g) => g.path);
    expect(paths).toContain('SchoolInfo/GetBasicSchoolInfo');
    expect(paths).toContain('Config/configsettings');
    await h.close();
  });
});
