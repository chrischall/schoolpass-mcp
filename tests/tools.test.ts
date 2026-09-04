import { describe, expect, it } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import type { SchoolPassClient } from '../src/client.js';
import { registerSessionTools } from '../src/tools/session.js';
import { registerParentTools } from '../src/tools/parent.js';
import { registerDismissalTools } from '../src/tools/dismissal.js';
import { registerChangeTools } from '../src/tools/changes.js';

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

/**
 * The `view` rollout, driven END TO END through the registered RPC path.
 *
 * `tests/view.test.ts` proves the helper strips media. It cannot prove a tool
 * CALLS it — which is the failure that shipped in a sibling repo, where
 * `viewResponse` was unit-tested and green while 14 of 26 tools were never
 * wired to it. So every read tool that takes `view` is driven here through
 * `callTool`, on a payload carrying an avatar, and asserted on the serialized
 * text a caller actually receives.
 *
 * The table is the wiring inventory: a new read tool added without `view`
 * belongs in it, and the count assertion below fails until it is.
 */
interface ViewCase {
  tool: string;
  register: (s: Parameters<Parameters<typeof createTestHarness>[0]>[0], c: SchoolPassClient) => void;
  args?: Record<string, unknown>;
  /** Endpoint bodies the fake client should hand back for this tool. */
  bodies: Record<string, unknown>;
  /** Where the avatar lives in the response the tool returns. */
  expectStripped: (payload: unknown) => unknown;
}

/** A record with an avatar, a page URL, and a field nobody anticipated. */
const RECORD = {
  studentId: 42,
  firstName: 'Ada',
  avatar: 'https://cdn.schoolpass.test/students/42.png',
  profileUrl: 'https://schoolpass.test/parent/students/42',
  somethingNobodyAnticipated: 'kept',
};

const VIEW_CASES: ViewCase[] = [
  {
    tool: 'schoolpass_list_students',
    register: (s, c) => registerParentTools(s, c),
    bodies: { 'parent/getstudents': [RECORD] },
    expectStripped: (p) => p,
  },
  {
    tool: 'schoolpass_get_profile',
    register: (s, c) => registerParentTools(s, c),
    bodies: { 'parent/profile': RECORD },
    expectStripped: (p) => p,
  },
  {
    tool: 'schoolpass_list_drivers',
    register: (s, c) => registerParentTools(s, c),
    bodies: { 'parent/parentdrivers': [RECORD] },
    expectStripped: (p) => p,
  },
  {
    tool: 'schoolpass_get_calendar',
    register: (s, c) => registerDismissalTools(s, c),
    args: { student_id: 42 },
    bodies: { 'Student/StudentCalendar': { dailyList: [RECORD] } },
    expectStripped: (p) => p,
  },
  {
    tool: 'schoolpass_list_pickup_changes',
    register: (s, c) => registerDismissalTools(s, c),
    args: { student_id: 42 },
    bodies: { 'PickupChange/GetChanges': [RECORD] },
    expectStripped: (p) => p,
  },
  {
    tool: 'schoolpass_list_dismissal_locations',
    register: (s, c) => registerDismissalTools(s, c),
    bodies: { 'dismissal/getDismissalLocations': [RECORD] },
    expectStripped: (p) => p,
  },
  {
    tool: 'schoolpass_get_school_info',
    register: (s, c) => registerDismissalTools(s, c),
    bodies: {
      'SchoolInfo/GetBasicSchoolInfo': RECORD,
      'Config/configsettings': { features: {} },
    },
    // This one ASSEMBLES its response from two endpoints, so the record the
    // avatar was on sits under `schoolInfo`.
    expectStripped: (p) => (p as { schoolInfo: unknown }).schoolInfo,
  },
];

describe('the view rollout, end to end', () => {
  it.each(VIEW_CASES)('$tool strips the avatar on the DEFAULT rung', async ({ tool, register, args, bodies, expectStripped }) => {
    const { client } = fakeClient(bodies);
    const h = await createTestHarness((s) => register(s, client));
    const raw = await h.callTool(tool, args);
    const text = (raw.content as { text: string }[])[0]!.text;

    // Asserted on the TEXT, not just the parse: this is what reaches a caller.
    expect(text).not.toContain('cdn.schoolpass.test');
    // Subtractive, so a field nobody anticipated is still there…
    expect(text).toContain('somethingNobodyAnticipated');
    // …and a page URL is not a picture.
    expect(text).toContain('parent/students/42');
    // Minified: no indentation, no newlines of its own.
    expect(text.split('\n')).toHaveLength(1);

    const record = expectStripped(parseToolResult(raw));
    const first = Array.isArray(record) ? record[0] : (record as { dailyList?: unknown[] })?.dailyList?.[0] ?? record;
    expect(first).not.toHaveProperty('avatar');
    expect(first).toMatchObject({ studentId: 42, somethingNobodyAnticipated: 'kept' });
    await h.close();
  });

  it.each(VIEW_CASES)('$tool returns the avatar untouched on view:full', async ({ tool, register, args, bodies }) => {
    const { client } = fakeClient(bodies);
    const h = await createTestHarness((s) => register(s, client));
    const raw = await h.callTool(tool, { ...args, view: 'full' });
    expect((raw.content as { text: string }[])[0]!.text).toContain('cdn.schoolpass.test/students/42.png');
    await h.close();
  });

  it.each(VIEW_CASES)('$tool never sends `view` upstream', async ({ tool, register, args, bodies }) => {
    // `view` is OUR vocabulary. Two repos leaked it into the query by spreading
    // the whole args object into the request; a tool that did that here would
    // put `view=full` on a SchoolPass URL.
    const { client, gets } = fakeClient(bodies);
    const h = await createTestHarness((s) => register(s, client));
    await h.callTool(tool, { ...args, view: 'full' });
    expect(gets.length).toBeGreaterThan(0);
    for (const g of gets) {
      expect(Object.keys(g.query ?? {})).not.toContain('view');
      expect(JSON.stringify(g.query ?? {})).not.toContain('full');
    }
    await h.close();
  });

  it('covers every read tool that takes a view parameter', async () => {
    // The guard on the guard. If a read tool gains `view` and is not added to
    // VIEW_CASES, the rollout is untested for it and this fails — which is
    // exactly how the sibling repo's 14 unwired tools stayed green.
    const { client } = fakeClient();
    const h = await createTestHarness((s) => {
      registerSessionTools(s, client);
      registerParentTools(s, client);
      registerDismissalTools(s, client);
      registerChangeTools(s, client);
    });
    // `h.client.listTools()`, not `h.listTools()`: the harness helper returns
    // names only, and the whole question here is which tools ADVERTISE `view`
    // in the schema an MCP host reads.
    const { tools } = await h.client.listTools();
    const withView = tools
      .filter((t) => Object.keys((t.inputSchema?.properties ?? {}) as Record<string, unknown>).includes('view'))
      .map((t) => t.name)
      .sort();
    expect(withView).toEqual(VIEW_CASES.map((c) => c.tool).sort());

    // And the write tools do NOT take one: a write's response is a receipt —
    // an id, a status — with nothing to strip and everything to keep.
    expect(withView).not.toContain('schoolpass_submit_dismissal_change');
    expect(withView).not.toContain('schoolpass_cancel_dismissal_change');
    await h.close();
  });
});
