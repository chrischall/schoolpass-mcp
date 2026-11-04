import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import type { SchoolPassClient } from '../src/client.js';
import { toolRegistrars } from '../src/registrars.js';
import {
  STUDENT_LIST_TIMEOUT_MS,
  buildStudentDirectory,
  loadStudentDirectory,
  resolveStudentId,
  studentIdArg,
  type StudentDirectory,
} from '../src/students.js';
import { calendarBriefLine } from '../src/tools/dismissal.js';

/**
 * Context-group hints (`_meta.mint`, mcp-host spec 2026-11-03 D4), asserted
 * against the SERVED tool list — what a host sees — for every tool, so a new
 * tool cannot skip the decision.
 */
type Listed = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  inputSchema: { properties?: Record<string, Record<string, unknown>> };
  _meta?: { mint?: Record<string, unknown> };
};

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const READ_INTENTS = ['whats-new', 'whats-due', 'whats-on'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];

/** Synthetic students only — no real names. */
const STUDENTS = [
  { id: 101, firstName: 'Alex', lastName: 'Example' },
  { id: 202, firstName: 'Sam', lastName: 'Sample' },
];

/** The calendar answer a fake SchoolPass returns, shaped like `Student/StudentCalendar`. */
const CALENDAR = {
  studentId: 101,
  dailyList: [
    { timestamp: '2026-11-05T00:00:00', studentChangeType: 4, adType: 3, isDefault: true, description: 'Pick up by the side door', moveToId: 7, changeId: null, changeSeriesId: null },
    { timestamp: '2026-11-06T00:00:00', studentChangeType: 3, adType: 3, isDefault: false, description: 'x'.repeat(300), moveToId: null, changeId: 9, changeSeriesId: 44 },
    { studentChangeType: 1, adType: 4, isDefault: false, changeId: 10, changeSeriesId: 45 },
  ],
};

function fakeClient(opts: { students?: unknown; failStudents?: boolean; hang?: boolean } = {}) {
  const gets: Array<{ path: string; query?: Record<string, unknown> }> = [];
  const client = {
    schoolCode: 1183,
    async getMemberId() {
      if (opts.hang) return new Promise<number>(() => {});
      return 5;
    },
    async get(path: string, query?: Record<string, unknown>) {
      gets.push({ path, query });
      if (path === 'parent/getstudents') {
        if (opts.failStudents) throw new Error('login rejected');
        return opts.students ?? STUDENTS;
      }
      if (path === 'Student/StudentCalendar') return CALENDAR;
      return [];
    },
  } as unknown as SchoolPassClient;
  return { client, gets };
}

async function served(students: StudentDirectory | null = null, client = fakeClient().client) {
  const h = await createTestHarness((server) => {
    for (const register of toolRegistrars(students)) register(server, client);
  });
  const { tools } = await h.client.listTools();
  return { tools: tools as unknown as Listed[], h };
}

const EXPECTED_INTENT: Record<string, string> = {
  schoolpass_whoami: 'lookup',
  schoolpass_list_students: 'lookup',
  schoolpass_get_profile: 'lookup',
  schoolpass_list_drivers: 'lookup',
  schoolpass_get_calendar: 'whats-on',
  schoolpass_list_pickup_changes: 'lookup',
  schoolpass_list_dismissal_locations: 'lookup',
  schoolpass_get_school_info: 'lookup',
  schoolpass_submit_dismissal_change: 'change',
  schoolpass_cancel_dismissal_change: 'change',
};

describe('_meta.mint on every served tool', () => {
  it('every tool except the healthcheck is hinted, and the table names them all', async () => {
    const { tools, h } = await served();
    await h.close();
    const hinted = tools.filter((t) => t._meta?.mint).map((t) => t.name).sort();
    expect(hinted).toEqual(Object.keys(EXPECTED_INTENT).sort());
    expect(tools.filter((t) => !t._meta?.mint).map((t) => t.name)).toEqual(['schoolpass_healthcheck']);
  });

  it.each(Object.entries(EXPECTED_INTENT))('%s is in the school group with intent %s', async (name, intent) => {
    const { tools, h } = await served();
    await h.close();
    const mint = tools.find((t) => t.name === name)?._meta?.mint;
    expect(mint?.domain).toBe('school');
    expect(mint?.intent).toBe(intent);
  });

  it('every hint is shaped per the host contract', async () => {
    for (const students of [null, directory()]) {
      const { tools, h } = await served(students);
      await h.close();
      for (const t of tools) {
        const m = t._meta?.mint;
        if (!m) continue;
        const props = t.inputSchema.properties ?? {};
        expect(Object.keys(m).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
        expect(DOMAINS, t.name).toContain(m.domain);
        expect(INTENTS, t.name).toContain(m.intent);
        if ('canonical' in m) {
          expect(m.canonical, t.name).toBe(true);
          expect(t.annotations?.readOnlyHint, t.name).toBe(true);
          expect(READ_INTENTS, t.name).toContain(m.intent);
        }
        if ('subject' in m) expect(props, t.name).toHaveProperty(m.subject as string);
        if ('when' in m) {
          const when = m.when as Record<string, string>;
          expect(Object.keys(when).sort(), t.name).toEqual(['end', 'start']);
          expect(props, t.name).toHaveProperty(when.start!);
          expect(props, t.name).toHaveProperty(when.end!);
        }
        if ('aliases' in m) {
          const aliases = m.aliases as string[];
          expect(aliases.length, t.name).toBeLessThanOrEqual(8);
          for (const a of aliases) {
            expect(a.length, t.name).toBeLessThanOrEqual(40);
            expect(a, t.name).toBe(a.toLowerCase());
            expect(a, t.name).not.toMatch(/^schoolpass_/);
          }
        }
      }
    }
  });

  it('at most one canonical read per what’s-new/due/on: the calendar for whats-on', async () => {
    const { tools, h } = await served();
    await h.close();
    const canonical = tools.filter((t) => t._meta?.mint?.canonical === true).map((t) => [t.name, t._meta!.mint!.intent]);
    expect(canonical).toEqual([['schoolpass_get_calendar', 'whats-on']]);
    for (const intent of READ_INTENTS) {
      expect(canonical.filter(([, i]) => i === intent).length).toBeLessThanOrEqual(1);
    }
  });

  it('the calendar names its subject and range arguments', async () => {
    const { tools, h } = await served();
    await h.close();
    expect(tools.find((t) => t.name === 'schoolpass_get_calendar')?._meta?.mint).toMatchObject({
      domain: 'school',
      intent: 'whats-on',
      canonical: true,
      subject: 'student_id',
      when: { start: 'start_date', end: 'end_date' },
    });
  });
});

function directory(): StudentDirectory {
  // Built through the real builder so the test exercises the same labels and resolution.
  return buildStudentDirectory(STUDENTS.map((s) => ({ id: s.id, name: `${s.firstName} ${s.lastName}` })))!;
}

describe('the student subject enum', () => {
  it('loads the parent’s students as labels at start, label or id accepted', async () => {
    const dir = await loadStudentDirectory(fakeClient().client);
    expect(dir?.labels).toEqual(['Alex Example', 'Sam Sample']);
    expect(dir?.resolve('alex example')).toBe(101);
    expect(dir?.resolve(' Sam Sample ')).toBe(202);
    expect(dir?.resolve('202')).toBe(202);
    expect(dir?.resolve(999)).toBe(999); // a raw id passes through; ownership is checked where it matters
    expect(() => dir?.resolve('Nobody')).toThrow(/Alex Example, Sam Sample/);
  });

  it('skips rows that are not students and names a nameless one by id', async () => {
    const dir = await loadStudentDirectory(
      fakeClient({ students: [null, 'x', { id: 'abc' }, { id: 0 }, { id: 3, firstName: ' ', lastName: null }] }).client,
    );
    expect(dir?.labels).toEqual(['Student 3']);
  });

  it('without a directory a numeric id passes and anything else is refused', () => {
    expect(resolveStudentId(null, 12)).toBe(12);
    expect(() => resolveStudentId(null, 'Alex')).toThrow(/not a student id/);
  });

  it('disambiguates two students who share a name with their ids', async () => {
    const dir = await loadStudentDirectory(
      fakeClient({ students: [{ id: 1, firstName: 'Jo', lastName: 'Twin' }, { id: 2, firstName: 'Jo', lastName: 'Twin' }] }).client,
    );
    expect(dir?.labels).toEqual(['Jo Twin (1)', 'Jo Twin (2)']);
    expect(dir?.resolve('jo twin (2)')).toBe(2);
  });

  it('answers null — never an empty enum — on failure, no students, or a slow listing', async () => {
    expect(await loadStudentDirectory(fakeClient({ failStudents: true }).client)).toBeNull();
    expect(await loadStudentDirectory(fakeClient({ students: [] }).client)).toBeNull();
    expect(await loadStudentDirectory(fakeClient({ students: { not: 'an array' } }).client)).toBeNull();
    expect(await loadStudentDirectory(fakeClient({ hang: true }).client, 20)).toBeNull();
    expect(STUDENT_LIST_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  it('publishes the labels as an enum on the student reads when listed', async () => {
    const { tools, h } = await served(directory());
    await h.close();
    for (const name of ['schoolpass_get_calendar', 'schoolpass_list_pickup_changes']) {
      const prop = tools.find((t) => t.name === name)!.inputSchema.properties!.student_id!;
      expect(prop.enum, name).toEqual(['Alex Example', 'Sam Sample']);
      expect(prop.type, name).toBe('string');
    }
  });

  it('says the names are the schema’s contract while the integer id is still accepted', async () => {
    const { tools, h } = await served(directory());
    await h.close();
    for (const name of ['schoolpass_get_calendar', 'schoolpass_list_pickup_changes']) {
      const prop = tools.find((t) => t.name === name)!.inputSchema.properties!.student_id!;
      expect(prop.description, name).toMatch(/by name as listed here/);
      expect(prop.description, name).toMatch(/also resolves an integer student id from schoolpass_list_students/);
      expect(prop.description, name).toMatch(/this schema offers the names only/);
    }
  });

  it('coerces an integer student id to the digit string the handler resolves', () => {
    const dir = directory();
    const arg = studentIdArg(dir);
    expect(arg.parse(202)).toBe('202');
    expect(resolveStudentId(dir, arg.parse(202) as string)).toBe(202);
    expect(resolveStudentId(dir, arg.parse('Alex Example') as string)).toBe(101);
    expect(() => arg.parse(0)).not.toThrow(); // shape only; resolution refuses it below
    expect(() => resolveStudentId(dir, arg.parse(0) as string)).toThrow(/Unknown student/);
  });

  it('both student reads accept an integer id with the enum published', async () => {
    const fake = fakeClient();
    const { h } = await served(directory(), fake.client);
    const a = await h.callTool('schoolpass_get_calendar', { student_id: 101 });
    const b = await h.callTool('schoolpass_list_pickup_changes', { student_id: 202, date: '2026-11-05' });
    await h.close();
    expect(a.isError).toBeFalsy();
    expect(b.isError).toBeFalsy();
    expect(fake.gets.map((g) => g.query?.studentId)).toEqual([101, 202]);
  });

  it('publishes no enum keyword when nothing was listed', async () => {
    const { tools, h } = await served(null);
    await h.close();
    const prop = tools.find((t) => t.name === 'schoolpass_get_calendar')!.inputSchema.properties!.student_id!;
    expect(prop).not.toHaveProperty('enum');
  });

  it('the calendar accepts a label and asks SchoolPass for that student’s id', async () => {
    const fake = fakeClient();
    const { h } = await served(directory(), fake.client);
    await h.callTool('schoolpass_get_calendar', { student_id: 'Sam Sample', start_date: '2026-11-05', end_date: '2026-11-06' });
    await h.callTool('schoolpass_list_pickup_changes', { student_id: 'alex example', date: '2026-11-05' });
    await h.callTool('schoolpass_get_calendar', { student_id: 202 });
    await h.close();
    expect(fake.gets.map((g) => g.query?.studentId)).toEqual([202, 101, 202]);
  });

  it('refuses an unknown label, naming the students', async () => {
    const { h } = await served(directory());
    const res = await h.callTool('schoolpass_get_calendar', { student_id: 'Nobody' });
    await h.close();
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/Unknown student/);
  });
});

describe('view: brief on the calendar', () => {
  it('answers one line per day entry, ≤ 120 chars, title — date — status', async () => {
    const { h } = await served();
    const res = await h.callTool('schoolpass_get_calendar', { student_id: 101, view: 'brief' });
    await h.close();
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    const lines = text.split('\n');
    expect(lines).toHaveLength(CALENDAR.dailyList.length);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(120);
      expect(line).toMatch(/^.+ — (\d{4}-\d{2}-\d{2}|no date) — .+$/);
    }
    expect(lines).toEqual([
      'carpool departure — 2026-11-05 — default',
      'early dismissal departure — 2026-11-06 — changed',
      'absent arrival and departure — no date — changed',
    ]);
    // Third-party free text (the day's description) never reaches a brief line.
    expect(text).not.toMatch(/side door/);
  });

  it('a malformed entry still answers one shaped line', () => {
    expect(calendarBriefLine(null)).toBe('no change type — no date — changed');
    expect(calendarBriefLine({ studentChangeType: 0, adType: 99, timestamp: 'soon', isDefault: true })).toBe(
      'no change type — no date — default',
    );
  });

  it('a calendar with no day list answers empty text', async () => {
    const client = { ...fakeClient().client, schoolCode: 1, async get() { return { dailyList: 'none' }; } } as unknown as SchoolPassClient;
    const { h } = await served(null, client);
    const res = await h.callTool('schoolpass_get_calendar', { student_id: 101, view: 'brief' });
    await h.close();
    expect((res.content as Array<{ text: string }>)[0]!.text).toBe('');
  });
});
