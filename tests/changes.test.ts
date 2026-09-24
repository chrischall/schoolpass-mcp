import { afterEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { createTestHarness, parseToolResult, type TestHarness } from '@chrischall/mcp-utils/test';
import type { SchoolPassClient } from '../src/client.js';
import { AdType, ENDPOINTS, SchoolPassTimeoutError, StudentChangeType } from '../src/protocol.js';
import { registerChangeTools, buildChangeBody, dayOfWeekId } from '../src/tools/changes.js';

// Fixture families. Invented names, never a real record.
const STUDENTS = [
  { id: 11278, firstName: 'Ava', lastName: 'Example', gradeId: 3 },
  { id: 1, firstName: 'Ben', lastName: 'Example', gradeId: 1 },
];

const saved = process.env.MCP_CONFIRM_MODE;
afterEach(() => {
  if (saved === undefined) delete process.env.MCP_CONFIRM_MODE;
  else process.env.MCP_CONFIRM_MODE = saved;
});

/** The phase-1 envelope the confirm-token fallback returns. */
interface PhaseOne {
  status: string;
  action: string;
  confirmToken: string;
  preview: Record<string, any>;
}

/** Call a gated tool twice — preview, then the same call plus its token. */
async function confirmed(h: TestHarness, tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const first = await h.callTool(tool, args);
  if (first.isError) return first; // a refusal before the gate is the answer
  const phase1 = parseToolResult<PhaseOne>(first);
  expect(phase1.status).toBe('confirmation-required');
  return h.callTool(tool, { ...args, confirmToken: phase1.confirmToken });
}

describe('dayOfWeekId', () => {
  it('returns ISO weekday ids (Monday=1 … Sunday=7) in UTC', () => {
    expect(dayOfWeekId('2026-09-14')).toBe(1); // Monday
    expect(dayOfWeekId('2026-09-13')).toBe(7); // Sunday
    expect(dayOfWeekId('2026-09-19')).toBe(6); // Saturday
  });
});

describe('buildChangeBody', () => {
  it('builds the app-shaped body with a single-day dateSet + weekday', () => {
    const body = buildChangeBody({ studentId: 11278, date: '2026-09-14', changeType: 4, adType: 3, moveToId: 8553 });
    expect(body).toMatchObject({
      studentId: 11278,
      moveToId: 8553,
      changeType: 4,
      adType: 3,
      changeSeriesId: 0,
      userType: 3,
    });
    expect(body.dateSet).toEqual({
      dates: [],
      daysOfWeek: [1],
      startDate: '2026-09-14',
      endDate: '2026-09-14',
      recurringWeeks: 0,
    });
  });

  it('defaults optional fields (no moveToId → null)', () => {
    const body = buildChangeBody({ studentId: 1, date: '2026-09-14', changeType: 1, adType: 3 });
    expect(body.moveToId).toBeNull();
    expect(body.notes).toBe('');
    expect(body.willReturn).toBe(false);
  });
});

/** A calendar entry in the shape docs/SCHOOLPASS-API.md describes. */
const DEFAULT_CARPOOL = {
  isDefault: true,
  changeId: null,
  changeSeriesId: null,
  studentChangeType: StudentChangeType.Carpool,
  adType: AdType.Departure,
  moveToId: 8553,
};
const LANDED_CARPOOL = {
  isDefault: false,
  changeId: 99,
  changeSeriesId: 4242,
  studentChangeType: StudentChangeType.Carpool,
  adType: AdType.Departure,
  moveToId: 505,
};

/**
 * Fake client: serves the parent's students, records submits, and serves a
 * calendar that (by default) shows the change once a submit happened.
 */
function fakeClient(opts: { afterChanges?: boolean; calendar?: () => unknown; submit?: () => Promise<unknown> } = {}): {
  client: SchoolPassClient;
  submits: unknown[];
} {
  const submits: unknown[] = [];
  let submitted = false;
  const client = {
    schoolCode: 1183,
    async getMemberId() {
      return 15348;
    },
    async submitStudentChange(body: unknown) {
      submits.push(body);
      if (opts.submit) return opts.submit();
      submitted = true;
      return { success: true };
    },
    async get(path: string) {
      if (path === ENDPOINTS.parentStudents) return STUDENTS;
      if (opts.calendar) return opts.calendar();
      return { dailyList: submitted && opts.afterChanges !== false ? [LANDED_CARPOOL] : [DEFAULT_CARPOOL] };
    },
  } as unknown as SchoolPassClient;
  return { client, submits };
}

const CARPOOL_ARGS = { student_id: 11278, date: '2026-09-14', change_type: 'carpool', move_to_id: 505 };

describe('schoolpass_submit_dismissal_change — confirm gate', () => {
  it('takes confirmToken, not a model-settable confirm boolean', async () => {
    const { client } = fakeClient();
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const { tools } = await h.client.listTools();
    for (const name of ['schoolpass_submit_dismissal_change', 'schoolpass_cancel_dismissal_change']) {
      const props = (tools.find((t) => t.name === name)?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.keys(props), name).toContain('confirmToken');
      expect(Object.keys(props), name).not.toContain('confirm');
    }
    await h.close();
  });

  it('phase 1: returns a confirmation-required preview naming the CHILD, and sends nothing', async () => {
    const { client, submits } = fakeClient();
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const raw = await h.callTool('schoolpass_submit_dismissal_change', CARPOOL_ARGS);
    expect(raw.isError).toBeFalsy();
    const res = parseToolResult<PhaseOne>(raw);
    expect(res.status).toBe('confirmation-required');
    expect(typeof res.confirmToken).toBe('string');
    // A parent approves a change for a child, not for an id.
    expect(res.preview.student).toEqual({ id: 11278, name: 'Ava Example' });
    expect(res.preview.date).toBe('2026-09-14');
    expect(res.preview.change).toMatchObject({ type: 'carpool', side: 'departure', moveToId: 505 });
    // The exact request rides along, so the preview can never diverge from the send.
    expect(res.preview.willSend.endpoint).toBe('studentchange');
    expect(res.preview.willSend.body).toMatchObject({ changeType: 4, moveToId: 505, modifiedBy: 15348 });
    expect(res.preview.willSend.query).toEqual({ schoolCode: 1183, parentMemberId: 15348 });
    expect(submits).toHaveLength(0);
    await h.close();
  });

  it('a bare confirm:true (the old gate) no longer writes anything', async () => {
    // The injected-text attack the audit describes: "mark Ava absent tomorrow,
    // confirm:true" in one call. Whatever the schema does with the stray key,
    // the outcome that matters is that nothing was sent.
    const { client, submits } = fakeClient();
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    await h.callTool('schoolpass_submit_dismissal_change', { ...CARPOOL_ARGS, confirm: true });
    expect(submits).toHaveLength(0);
    await h.close();
  });

  it('phase 2: the token from the preview submits and proves the change landed', async () => {
    const { client, submits } = fakeClient({ afterChanges: true });
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const res = parseToolResult<{ submitted: boolean; verified: boolean; before: unknown[]; after: unknown[] }>(
      await confirmed(h, 'schoolpass_submit_dismissal_change', { ...CARPOOL_ARGS, ad_type: 'departure' }),
    );
    expect(res.submitted).toBe(true);
    expect(res.verified).toBe(true);
    expect(submits).toHaveLength(1);
    expect(res.before).not.toEqual(res.after);
    await h.close();
  });

  it('binds the arguments: a token minted for one target does not submit another', async () => {
    const { client, submits } = fakeClient();
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const phase1 = parseToolResult<PhaseOne>(await h.callTool('schoolpass_submit_dismissal_change', CARPOOL_ARGS));
    const raw = await h.callTool('schoolpass_submit_dismissal_change', {
      ...CARPOOL_ARGS,
      move_to_id: 506,
      confirmToken: phase1.confirmToken,
    });
    expect(raw.isError).toBe(true);
    expect(parseToolResult<{ error: string }>(raw).error).toBe('DRAFT_CHANGED');
    expect(submits).toHaveLength(0);
    await h.close();
  });

  it('binds the day: a change that appears between preview and confirm is DRAFT_CHANGED', async () => {
    // The other parent (or the school) touched the day after the user approved
    // the preview. What would happen is no longer what they saw.
    let day: unknown[] = [DEFAULT_CARPOOL];
    const { client, submits } = fakeClient({ calendar: () => ({ dailyList: day }) });
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const phase1 = parseToolResult<PhaseOne>(await h.callTool('schoolpass_submit_dismissal_change', CARPOOL_ARGS));
    day = [
      DEFAULT_CARPOOL,
      { isDefault: false, changeId: 5, changeSeriesId: 55, studentChangeType: StudentChangeType.Absent, adType: AdType.Both, moveToId: null },
    ];
    const raw = await h.callTool('schoolpass_submit_dismissal_change', { ...CARPOOL_ARGS, confirmToken: phase1.confirmToken });
    expect(raw.isError).toBe(true);
    const res = parseToolResult<{ error: string; reason: string; confirmToken: string; preview: { currentDay: unknown[] } }>(raw);
    expect(res.error).toBe('DRAFT_CHANGED');
    expect(res.reason).toBe('revision-changed');
    // ...and the fresh preview shows the day as it is NOW, with a new token.
    expect(res.preview.currentDay).toHaveLength(2);
    expect(typeof res.confirmToken).toBe('string');
    expect(submits).toHaveLength(0);
    await h.close();
  });

  it('a token is single-use', async () => {
    const { client, submits } = fakeClient({ calendar: () => ({ dailyList: [DEFAULT_CARPOOL] }) });
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const phase1 = parseToolResult<PhaseOne>(await h.callTool('schoolpass_submit_dismissal_change', CARPOOL_ARGS));
    const first = await h.callTool('schoolpass_submit_dismissal_change', { ...CARPOOL_ARGS, confirmToken: phase1.confirmToken });
    expect(first.isError).toBeFalsy();
    const again = await h.callTool('schoolpass_submit_dismissal_change', { ...CARPOOL_ARGS, confirmToken: phase1.confirmToken });
    expect(again.isError).toBe(true);
    expect(parseToolResult<{ error: string }>(again).error).toBe('TOKEN_REUSED');
    expect(submits).toHaveLength(1);
    await h.close();
  });

  it('refuses a student_id that is not one of this parent’s students, before any write', async () => {
    const { client, submits } = fakeClient();
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const raw = await h.callTool('schoolpass_submit_dismissal_change', { ...CARPOOL_ARGS, student_id: 99999 });
    expect(raw.isError).toBe(true);
    expect(raw.content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/schoolpass_list_students/) });
    expect(submits).toHaveLength(0);
    await h.close();
  });

  it('refuses the write under MCP_CONFIRM_MODE=refuse on a client that cannot be prompted', async () => {
    process.env.MCP_CONFIRM_MODE = 'refuse';
    const { client, submits } = fakeClient();
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const raw = await h.callTool('schoolpass_submit_dismissal_change', CARPOOL_ARGS);
    expect(parseToolResult<{ reason: string }>(raw).reason).toBe('confirmation-unsupported');
    expect(submits).toHaveLength(0);
    await h.close();
  });
});

describe('schoolpass_submit_dismissal_change — after the gate', () => {
  it('reports an unverified submit — NOT an error — when the calendar does not show the change', async () => {
    // The POST reached SchoolPass. An error here would invite the model to
    // retry, sending a second POST (changeSeriesId 0) that can create a
    // duplicate change series on the child's day. So once the write resolves,
    // the tool never fails: it says the write went through but is unverified.
    const { client, submits } = fakeClient({ afterChanges: false });
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const raw = await confirmed(h, 'schoolpass_submit_dismissal_change', { ...CARPOOL_ARGS, move_to_id: 8553 });
    expect(raw.isError).toBeFalsy();
    const res = parseToolResult<{ submitted: boolean; verified: boolean; after: unknown[]; note: string }>(raw);
    expect(res.submitted).toBe(true);
    expect(res.verified).toBe(false);
    expect(res.after).toHaveLength(1);
    expect(res.note).toMatch(/do not resubmit/i);
    expect(res.note).toMatch(/move_to_id/);
    expect(submits).toHaveLength(1);
    await h.close();
  });

  it('does not fail when the calendar re-read after a successful submit throws', async () => {
    // A network blip / 5xx on StudentCalendar AFTER the write must not turn an
    // accepted change into a failed call the model will retry.
    let submitted = false;
    const submits: unknown[] = [];
    const client = {
      schoolCode: 1183,
      async getMemberId() { return 15348; },
      async submitStudentChange(body: unknown) { submits.push(body); submitted = true; return { success: true }; },
      async get(path: string) {
        if (path === ENDPOINTS.parentStudents) return STUDENTS;
        if (submitted) throw new Error('SchoolPass API error: 503 Service Unavailable');
        return { dailyList: [] };
      },
    } as unknown as SchoolPassClient;
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const raw = await confirmed(h, 'schoolpass_submit_dismissal_change', CARPOOL_ARGS);
    expect(raw.isError).toBeFalsy();
    const res = parseToolResult<{
      submitted: boolean; verified: boolean; response: unknown; after?: unknown; readError: string; note: string;
    }>(raw);
    expect(res.submitted).toBe(true);
    expect(res.verified).toBe(false);
    expect(res.response).toEqual({ success: true });
    expect(res.after).toBeUndefined();
    expect(res.readError).toContain('503');
    expect(res.note).toMatch(/do not resubmit/i);
    expect(submits).toHaveLength(1);
    await h.close();
  });

  it('reports submitted:"unknown" — NOT an error — when the POST itself times out', async () => {
    // The write may have landed while the connection stalled. An error would
    // read as "nothing happened" and invite the duplicate-change retry.
    const { client, submits } = fakeClient({
      submit: async () => {
        throw new SchoolPassTimeoutError('https://x/api/studentchange', 30_000, new DOMException('t', 'TimeoutError'));
      },
    });
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const raw = await confirmed(h, 'schoolpass_submit_dismissal_change', CARPOOL_ARGS);
    expect(raw.isError).toBeFalsy();
    const res = parseToolResult<{ submitted: string; verified: boolean; error: string; note: string }>(raw);
    expect(res.submitted).toBe('unknown');
    expect(res.verified).toBe(false);
    expect(res.error).toMatch(/timed out|did not answer/i);
    expect(res.note).toMatch(/do not resubmit/i);
    expect(submits).toHaveLength(1);
    await h.close();
  });

  it('still throws — before any write — when the POST fails with a server error', async () => {
    // A 400/500 means the write did NOT land; surfacing it is right and a retry is safe.
    const { client } = fakeClient({ submit: async () => { throw new Error('SchoolPass API error on studentchange: HTTP 400'); } });
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const raw = await confirmed(h, 'schoolpass_submit_dismissal_change', CARPOOL_ARGS);
    expect(raw.isError).toBe(true);
    await h.close();
  });

  it('still fails — before any write — when the pre-submit calendar read throws', async () => {
    const submits: unknown[] = [];
    const client = {
      schoolCode: 1183,
      async getMemberId() { return 15348; },
      async submitStudentChange(body: unknown) { submits.push(body); return { success: true }; },
      async get(path: string) {
        if (path === ENDPOINTS.parentStudents) return STUDENTS;
        throw new Error('SchoolPass API error: 503');
      },
    } as unknown as SchoolPassClient;
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const res = await h.callTool('schoolpass_submit_dismissal_change', CARPOOL_ARGS);
    expect(res.isError).toBe(true);
    expect(submits).toHaveLength(0);
    await h.close();
  });

  it('treats a calendar read with no dailyList as an empty day', async () => {
    // before-reads return undefined (no dailyList); the after-read shows a change.
    let submitted = false;
    const client = {
      schoolCode: 1183,
      async getMemberId() { return 15348; },
      async submitStudentChange() { submitted = true; return { ok: true }; },
      async get(path: string) {
        if (path === ENDPOINTS.parentStudents) return STUDENTS;
        // The after-read must carry the documented proof shape (non-default +
        // populated changeSeriesId, matching the submitted change_type), or the
        // landed check correctly refuses it — this test is about the missing
        // dailyList on the BEFORE reads, not about the verification.
        return submitted
          ? { dailyList: [{ isDefault: false, changeId: 7, changeSeriesId: 77, studentChangeType: StudentChangeType.Absent, adType: AdType.Departure, moveToId: null }] }
          : undefined;
      },
    } as unknown as SchoolPassClient;
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const res = parseToolResult<{ submitted: boolean; before: unknown[] }>(
      await confirmed(h, 'schoolpass_submit_dismissal_change', { student_id: 1, date: '2026-09-14', change_type: 'absent' }),
    );
    expect(res.submitted).toBe(true);
    expect(res.before).toEqual([]);
    await h.close();
  });

  it('reports alreadyInPlace instead of failing an idempotent re-submit', async () => {
    // The requested change is ALREADY on the day, so nothing moves. A
    // before/after diff would call that a failed write; the documented proof is
    // the presence of a matching non-default entry, which holds.
    const { client } = fakeClient({ calendar: () => ({ dailyList: [LANDED_CARPOOL] }) });
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const res = parseToolResult<{ submitted: boolean; alreadyInPlace: boolean }>(
      await confirmed(h, 'schoolpass_submit_dismissal_change', CARPOOL_ARGS),
    );
    expect(res.submitted).toBe(true);
    expect(res.alreadyInPlace).toBe(true);
    await h.close();
  });

  it('reports unverified when the day changes but not into the requested state', async () => {
    // A diff-based check would pass this: before !== after. The change that
    // appeared is a DIFFERENT type, so the requested write did not land.
    let submitted = false;
    const client = {
      schoolCode: 1183,
      async getMemberId() { return 15348; },
      async submitStudentChange() { submitted = true; return { success: true }; },
      async get(path: string) {
        if (path === ENDPOINTS.parentStudents) return STUDENTS;
        return {
          dailyList: submitted
            ? [{ isDefault: false, changeId: 1, changeSeriesId: 1, studentChangeType: StudentChangeType.Absent, adType: AdType.Departure, moveToId: null }]
            : [DEFAULT_CARPOOL],
        };
      },
    } as unknown as SchoolPassClient;
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const raw = await confirmed(h, 'schoolpass_submit_dismissal_change', CARPOOL_ARGS);
    expect(raw.isError).toBeFalsy();
    const res = parseToolResult<{ submitted: boolean; verified: boolean }>(raw);
    expect(res.submitted).toBe(true);
    expect(res.verified).toBe(false);
    await h.close();
  });

  it('requires move_to_id for a carpool change', async () => {
    const { client, submits } = fakeClient();
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const res = await h.callTool('schoolpass_submit_dismissal_change', {
      student_id: 11278, date: '2026-09-14', change_type: 'carpool',
    });
    expect(res.isError).toBe(true);
    expect(submits).toHaveLength(0); // refused BEFORE any write
    await h.close();
  });

  it('requires move_to_id for a bus change too', async () => {
    // Covers the bus arm of the required-target hint, which names a different
    // id source than the carpool arm.
    const { client, submits } = fakeClient();
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const res = await h.callTool('schoolpass_submit_dismissal_change', {
      student_id: 11278, date: '2026-09-14', change_type: 'bus',
    });
    expect(res.isError).toBe(true);
    expect(submits).toHaveLength(0);
    await h.close();
  });

  it('reports an unverified targetless change without naming move_to_id', async () => {
    // Same landed-check failure as above but with NO move_to_id, so the hint
    // omits it — an `absent` change the calendar never reflects.
    let submitted = false;
    const client = {
      schoolCode: 1183,
      async getMemberId() { return 15348; },
      async submitStudentChange() { submitted = true; return { success: true }; },
      async get(path: string) {
        if (path === ENDPOINTS.parentStudents) return STUDENTS;
        return {
          dailyList: submitted
            ? [{ isDefault: false, changeId: 1, changeSeriesId: 1, studentChangeType: StudentChangeType.Carpool, adType: AdType.Departure, moveToId: 505 }]
            : [{ isDefault: true, changeId: null, changeSeriesId: null, studentChangeType: StudentChangeType.Absent, adType: AdType.Departure, moveToId: null }],
        };
      },
    } as unknown as SchoolPassClient;
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const raw = await confirmed(h, 'schoolpass_submit_dismissal_change', { student_id: 11278, date: '2026-09-14', change_type: 'absent' });
    expect(raw.isError).toBeFalsy();
    const res = parseToolResult<{ verified: boolean; note: string }>(raw);
    expect(res.verified).toBe(false);
    expect(res.note).not.toMatch(/move_to_id/);
    await h.close();
  });

  it('passes bus_stop_id through to the request body', async () => {
    const { client, submits } = fakeClient();
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    await confirmed(h, 'schoolpass_submit_dismissal_change', {
      student_id: 11278, date: '2026-09-14', change_type: 'bus', move_to_id: 61, bus_stop_id: 909,
    });
    expect((submits[0] as { busStopId?: number }).busStopId).toBe(909);
    await h.close();
  });

  it('rejects an invalid change_type', async () => {
    const { client } = fakeClient();
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const res = await h.callTool('schoolpass_submit_dismissal_change', {
      student_id: 1,
      date: '2026-09-14',
      change_type: 'teleport',
    });
    expect(res.isError).toBe(true);
    await h.close();
  });
});

const ABSENT_CHANGE = { isDefault: false, changeSeriesId: 27074, studentChangeType: 1, adType: 4, description: 'Absent' };

/** Client whose calendar shows a non-default change until it is deleted. */
function cancelClient(entries?: () => unknown[]): { client: SchoolPassClient; deletes: unknown[] } {
  const deletes: unknown[] = [];
  let deleted = false;
  const client = {
    schoolCode: 1183,
    async getMemberId() {
      return 15348;
    },
    async deleteStudentChange(args: unknown) {
      deletes.push(args);
      deleted = true;
      return { ok: true };
    },
    async get(path: string) {
      if (path === ENDPOINTS.parentStudents) return STUDENTS;
      if (entries) return { dailyList: entries() };
      return {
        dailyList: deleted
          ? [{ isDefault: true, changeSeriesId: null, studentChangeType: 4, adType: 3 }]
          : [ABSENT_CHANGE],
      };
    },
  } as unknown as SchoolPassClient;
  return { client, deletes };
}

describe('schoolpass_cancel_dismissal_change', () => {
  it('phase 1: previews the change to cancel, naming the child, without deleting', async () => {
    const { client, deletes } = cancelClient();
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const res = parseToolResult<PhaseOne>(
      await h.callTool('schoolpass_cancel_dismissal_change', { student_id: 11278, date: '2026-09-14' }),
    );
    expect(res.status).toBe('confirmation-required');
    expect(res.preview.student).toEqual({ id: 11278, name: 'Ava Example' });
    expect(res.preview.wouldCancel).toMatchObject({ changeSeriesId: 27074, changeType: 'absent', description: 'Absent', date: '2026-09-14' });
    expect(res.preview.willSend).toMatchObject({ method: 'DELETE', endpoint: ENDPOINTS.deleteStudentChange });
    expect(deletes).toHaveLength(0);
    await h.close();
  });

  it('a bare confirm:true (the old gate) no longer deletes anything', async () => {
    const { client, deletes } = cancelClient();
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    await h.callTool('schoolpass_cancel_dismissal_change', { student_id: 11278, date: '2026-09-14', confirm: true });
    expect(deletes).toHaveLength(0);
    await h.close();
  });

  it('phase 2: the token from the preview cancels and confirms the day cleared', async () => {
    const { client, deletes } = cancelClient();
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const res = parseToolResult<{ cancelled: boolean; cleared: boolean }>(
      await confirmed(h, 'schoolpass_cancel_dismissal_change', { student_id: 11278, date: '2026-09-14' }),
    );
    expect(res.cancelled).toBe(true);
    expect(res.cleared).toBe(true);
    expect(deletes[0]).toMatchObject({ changeSeriesId: 27074, changeType: 1, adType: 4, date: '2026-09-14' });
    await h.close();
  });

  it('binds the previewed change: a DIFFERENT single change on the day at confirm time is not deleted', async () => {
    // The audit's scenario: no change_series_id given, so the tool picks "the
    // one cancellable change". If that one is replaced between preview and
    // confirm, the token must not carry the approval over to the newcomer.
    let day: unknown[] = [ABSENT_CHANGE];
    const { client, deletes } = cancelClient(() => day);
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const phase1 = parseToolResult<PhaseOne>(
      await h.callTool('schoolpass_cancel_dismissal_change', { student_id: 11278, date: '2026-09-14' }),
    );
    day = [{ isDefault: false, changeSeriesId: 31000, studentChangeType: 3, adType: 3, description: 'Early dismissal' }];
    const raw = await h.callTool('schoolpass_cancel_dismissal_change', {
      student_id: 11278, date: '2026-09-14', confirmToken: phase1.confirmToken,
    });
    expect(raw.isError).toBe(true);
    expect(parseToolResult<{ status: string }>(raw).status).toBe('confirmation-rejected');
    expect(deletes).toHaveLength(0);
    await h.close();
  });

  it('errors when the calendar read has no dailyList at all', async () => {
    const client = {
      schoolCode: 1183,
      async get() {
        return undefined; // no dailyList → treated as an empty day
      },
    } as unknown as SchoolPassClient;
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const res = await h.callTool('schoolpass_cancel_dismissal_change', { student_id: 1, date: '2026-09-14' });
    expect(res.isError).toBe(true);
    await h.close();
  });

  it('reports cleared:false when the change survives the delete', async () => {
    // Calendar keeps showing the non-default change even after delete.
    const client = {
      schoolCode: 1183,
      async getMemberId() { return 15348; },
      async deleteStudentChange() {
        return { ok: true };
      },
      async get(path: string) {
        if (path === ENDPOINTS.parentStudents) return STUDENTS;
        return { dailyList: [{ isDefault: false, changeSeriesId: 27074, studentChangeType: 1, adType: 4 }] };
      },
    } as unknown as SchoolPassClient;
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const res = parseToolResult<{ cancelled: boolean; cleared: boolean }>(
      await confirmed(h, 'schoolpass_cancel_dismissal_change', { student_id: 1, date: '2026-09-14' }),
    );
    expect(res.cancelled).toBe(true);
    expect(res.cleared).toBe(false);
    await h.close();
  });
});

describe('schoolpass_cancel_dismissal_change targeting', () => {
  const TWO = [
    { isDefault: false, changeId: 11, changeSeriesId: 11, studentChangeType: StudentChangeType.Carpool, adType: AdType.Departure, moveToId: null },
    { isDefault: false, changeId: 22, changeSeriesId: 22, studentChangeType: StudentChangeType.Absent, adType: AdType.Departure, moveToId: null },
  ];

  it('refuses to guess when the date carries several changes', async () => {
    const { client, deletes } = cancelClient(() => TWO);
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const res = await h.callTool('schoolpass_cancel_dismissal_change', { student_id: 11278, date: '2026-09-14' });
    expect(res.isError).toBe(true);
    expect(deletes).toHaveLength(0);
    await h.close();
  });

  it('cancels the change_series_id it was given', async () => {
    const { client, deletes } = cancelClient(() => TWO);
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    await confirmed(h, 'schoolpass_cancel_dismissal_change', { student_id: 11278, date: '2026-09-14', change_series_id: 22 });
    expect((deletes[0] as { changeSeriesId?: number }).changeSeriesId).toBe(22);
    await h.close();
  });

  it('errors when the given change_series_id is not on that date', async () => {
    const { client } = cancelClient(() => [TWO[0]!]);
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const res = await h.callTool('schoolpass_cancel_dismissal_change', {
      student_id: 11278, date: '2026-09-14', change_series_id: 999,
    });
    expect(res.isError).toBe(true);
    await h.close();
  });
});

describe('write-tool annotations', () => {
  it('marks both writes destructive and non-idempotent so clients gate them for a human', async () => {
    // The confirm token is carried by the model, not a person — the annotation
    // is the other signal a client has to put an approval prompt in front of
    // the call. Cancelling DELETEs a child's real dismissal arrangement, so it
    // must be gated exactly like submit.
    const { client } = cancelClient();
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const { tools } = await h.client.listTools();
    for (const name of ['schoolpass_submit_dismissal_change', 'schoolpass_cancel_dismissal_change']) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      // Absent means false per the MCP spec; it must never claim idempotency.
      expect(tool?.annotations?.idempotentHint, name).not.toBe(true);
    }
    await h.close();
  });
});
