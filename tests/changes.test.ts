import { describe, expect, it } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import type { SchoolPassClient } from '../src/client.js';
import { registerChangeTools, buildChangeBody, dayOfWeekId } from '../src/tools/changes.js';

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

/** Fake client recording submits + serving before/after calendar reads. */
function fakeClient(opts: { afterChanges?: boolean } = {}): {
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
      submitted = true;
      return { success: true };
    },
    async get(_path: string) {
      // Calendar read: return a different shape once a submit happened.
      return {
        dailyList:
          submitted && opts.afterChanges !== false
            ? [{ isDefault: false, changeId: 99, moveToId: 505 }]
            : [{ isDefault: true, changeId: null, moveToId: 8553 }],
      };
    },
  } as unknown as SchoolPassClient;
  return { client, submits };
}

describe('schoolpass_submit_dismissal_change', () => {
  it('returns a dry-run preview and does NOT submit without confirm', async () => {
    const { client, submits } = fakeClient();
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const res = parseToolResult<{ dryRun: boolean; willSend: { endpoint: string; body: Record<string, unknown> } }>(
      await h.callTool('schoolpass_submit_dismissal_change', {
        student_id: 11278,
        date: '2026-09-14',
        change_type: 'carpool',
        move_to_id: 8553,
      }),
    );
    expect(res.dryRun).toBe(true);
    expect(res.willSend.endpoint).toBe('studentchange');
    expect(res.willSend.body.changeType).toBe(4);
    expect(submits).toHaveLength(0);
    await h.close();
  });

  it('submits with confirm:true and proves the change landed', async () => {
    const { client, submits } = fakeClient({ afterChanges: true });
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const res = parseToolResult<{ submitted: boolean; before: unknown[]; after: unknown[] }>(
      await h.callTool('schoolpass_submit_dismissal_change', {
        student_id: 11278,
        date: '2026-09-14',
        change_type: 'carpool',
        ad_type: 'departure',
        move_to_id: 505,
        confirm: true,
      }),
    );
    expect(res.submitted).toBe(true);
    expect(submits).toHaveLength(1);
    expect(res.before).not.toEqual(res.after);
    await h.close();
  });

  it('errors when the submit succeeds but the calendar did not change', async () => {
    const { client } = fakeClient({ afterChanges: false });
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const res = await h.callTool('schoolpass_submit_dismissal_change', {
      student_id: 11278,
      date: '2026-09-14',
      change_type: 'carpool',
      move_to_id: 8553,
      confirm: true,
    });
    expect(res.isError).toBe(true);
    await h.close();
  });

  it('treats a calendar read with no dailyList as an empty day', async () => {
    // before-read returns undefined (no dailyList), after-read returns a change.
    let reads = 0;
    const client = {
      schoolCode: 1183,
      async getMemberId() {
        return 15348;
      },
      async submitStudentChange() {
        return { ok: true };
      },
      async get() {
        reads += 1;
        return reads === 1 ? undefined : { dailyList: [{ isDefault: false, changeId: 7 }] };
      },
    } as unknown as SchoolPassClient;
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const res = parseToolResult<{ submitted: boolean; before: unknown[] }>(
      await h.callTool('schoolpass_submit_dismissal_change', {
        student_id: 1,
        date: '2026-09-14',
        change_type: 'absent',
        confirm: true,
      }),
    );
    expect(res.submitted).toBe(true);
    expect(res.before).toEqual([]);
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

/** Client whose calendar shows a non-default change until it is deleted. */
function cancelClient(): { client: SchoolPassClient; deletes: unknown[] } {
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
    async get() {
      return {
        dailyList: deleted
          ? [{ isDefault: true, changeSeriesId: null, studentChangeType: 4, adType: 3 }]
          : [{ isDefault: false, changeSeriesId: 27074, studentChangeType: 1, adType: 4, description: 'Absent' }],
      };
    },
  } as unknown as SchoolPassClient;
  return { client, deletes };
}

describe('schoolpass_cancel_dismissal_change', () => {
  it('previews the change to cancel without deleting', async () => {
    const { client, deletes } = cancelClient();
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const res = parseToolResult<{ dryRun: boolean; wouldCancel: { changeSeriesId: number } }>(
      await h.callTool('schoolpass_cancel_dismissal_change', { student_id: 11278, date: '2026-09-14' }),
    );
    expect(res.dryRun).toBe(true);
    expect(res.wouldCancel.changeSeriesId).toBe(27074);
    expect(deletes).toHaveLength(0);
    await h.close();
  });

  it('cancels with confirm:true and confirms the day cleared', async () => {
    const { client, deletes } = cancelClient();
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const res = parseToolResult<{ cancelled: boolean; cleared: boolean }>(
      await h.callTool('schoolpass_cancel_dismissal_change', {
        student_id: 11278,
        date: '2026-09-14',
        confirm: true,
      }),
    );
    expect(res.cancelled).toBe(true);
    expect(res.cleared).toBe(true);
    expect(deletes[0]).toMatchObject({ changeSeriesId: 27074, changeType: 1, adType: 4, date: '2026-09-14' });
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
      async deleteStudentChange() {
        return { ok: true };
      },
      async get() {
        return { dailyList: [{ isDefault: false, changeSeriesId: 27074, studentChangeType: 1, adType: 4 }] };
      },
    } as unknown as SchoolPassClient;
    const h = await createTestHarness((s) => registerChangeTools(s, client));
    const res = parseToolResult<{ cancelled: boolean; cleared: boolean }>(
      await h.callTool('schoolpass_cancel_dismissal_change', {
        student_id: 1,
        date: '2026-09-14',
        confirm: true,
      }),
    );
    expect(res.cancelled).toBe(true);
    expect(res.cleared).toBe(false);
    await h.close();
  });
});
