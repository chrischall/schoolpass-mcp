import { afterEach, describe, expect, it, vi } from 'vitest';
import { todayIso } from '@chrischall/mcp-utils';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import type { SchoolPassClient } from '../src/client.js';
import { SchoolPassConfigError } from '../src/config.js';
import { schoolToday } from '../src/dates.js';
import { registerDismissalTools } from '../src/tools/dismissal.js';

// fleet-audit#689: a hosted server runs in UTC, so "today" read off the process
// clock rolls over to tomorrow during a US school evening.
// 2026-03-10T01:30Z is 2026-03-09 21:30 in New York.
const EVENING_EASTERN = new Date('2026-03-10T01:30:00Z');

describe('schoolToday', () => {
  it('uses SCHOOLPASS_TIMEZONE when set, not the process clock zone', () => {
    expect(schoolToday({ SCHOOLPASS_TIMEZONE: 'America/New_York' }, EVENING_EASTERN)).toBe('2026-03-09');
    expect(schoolToday({ SCHOOLPASS_TIMEZONE: 'UTC' }, EVENING_EASTERN)).toBe('2026-03-10');
  });

  it('falls back to the local zone when unset', () => {
    expect(schoolToday({}, EVENING_EASTERN)).toBe(todayIso(EVENING_EASTERN));
  });

  it('rejects a timezone that is not an IANA zone', () => {
    expect(() => schoolToday({ SCHOOLPASS_TIMEZONE: 'Mars/Olympus' }, EVENING_EASTERN)).toThrow(
      SchoolPassConfigError,
    );
  });
});

describe('dismissal tools default "today" in the school timezone', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('get_calendar and list_pickup_changes default to the school-local date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(EVENING_EASTERN);
    vi.stubEnv('SCHOOLPASS_TIMEZONE', 'America/New_York');
    const queries: Record<string, unknown>[] = [];
    const client = {
      schoolCode: 1183,
      async get(_path: string, query: Record<string, unknown>) {
        queries.push(query);
        return {};
      },
    } as unknown as SchoolPassClient;
    const h = await createTestHarness((s) => registerDismissalTools(s, client));
    await h.callTool('schoolpass_get_calendar', { student_id: 42 });
    await h.callTool('schoolpass_list_pickup_changes', { student_id: 42 });
    expect(queries[0]).toMatchObject({ startDate: '2026-03-09', endDate: '2026-03-23' });
    expect(queries[1]).toMatchObject({ date: '2026-03-09' });
    await h.close();
  });
});
