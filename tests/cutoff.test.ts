import { describe, expect, it } from 'vitest';
import type { SchoolPassClient } from '../src/client.js';
import { ENDPOINTS } from '../src/protocol.js';
import {
  earlyDismissalLatestFromEnv,
  parseSchoolClock,
  parseTimeOfDay,
  resolveEarlyDismissalCutoff,
} from '../src/cutoff.js';

describe('parseTimeOfDay', () => {
  it('accepts 24-hour HH:MM', () => {
    expect(parseTimeOfDay('14:00')).toBe(14 * 60);
    expect(parseTimeOfDay('13:15')).toBe(13 * 60 + 15);
    expect(parseTimeOfDay('00:00')).toBe(0);
    expect(parseTimeOfDay('23:59')).toBe(23 * 60 + 59);
  });

  it.each(['2:30', '14:3', '24:00', '14:60', '2:30 PM', '14.30', '1430', '', ' 14:00', 'noon'])(
    'refuses %j',
    (raw) => {
      expect(parseTimeOfDay(raw)).toBeNull();
    },
  );
});

describe('parseSchoolClock', () => {
  it('reads the 12-hour clock SchoolPass stores ("2:10 PM") as HH:MM', () => {
    expect(parseSchoolClock('2:10 PM')).toBe('14:10');
    expect(parseSchoolClock('7:00 AM')).toBe('07:00');
    expect(parseSchoolClock('12:05 PM')).toBe('12:05');
    expect(parseSchoolClock('12:30 AM')).toBe('00:30');
    expect(parseSchoolClock('2:10pm')).toBe('14:10');
  });

  it('also takes a 24-hour value', () => {
    expect(parseSchoolClock('14:10')).toBe('14:10');
  });

  it.each([null, undefined, '', 'soon', '13:10 PM', 42])('refuses %j', (raw) => {
    expect(parseSchoolClock(raw)).toBeNull();
  });
});

describe('earlyDismissalLatestFromEnv', () => {
  it('has no built-in value: unset means unknown', () => {
    expect(earlyDismissalLatestFromEnv({})).toBeUndefined();
  });

  it('reads SCHOOLPASS_EARLY_DISMISSAL_LATEST', () => {
    expect(earlyDismissalLatestFromEnv({ SCHOOLPASS_EARLY_DISMISSAL_LATEST: '13:30' })).toEqual({
      latest: '13:30',
      source: 'config',
    });
  });

  it('treats a blank value as unset', () => {
    expect(earlyDismissalLatestFromEnv({ SCHOOLPASS_EARLY_DISMISSAL_LATEST: '  ' })).toBeUndefined();
  });

  it('refuses a malformed value rather than guessing', () => {
    expect(() => earlyDismissalLatestFromEnv({ SCHOOLPASS_EARLY_DISMISSAL_LATEST: '2pm' })).toThrow(
      /SCHOOLPASS_EARLY_DISMISSAL_LATEST/,
    );
  });
});

/** The shape `GET v1/admin/cutofftimes` returned live (school 1183, 2026-11-20). */
const LIVE_CUTOFFS = [1, 2, 3, 4, 5].map((day) => ({
  day,
  earlyPickup: '2:10 PM',
  pmCutoff: '2:55 PM',
  amCutoff: '7:00 AM',
}));

function cutoffClient(serve: () => unknown): { client: SchoolPassClient; paths: string[] } {
  const paths: string[] = [];
  const client = {
    schoolCode: 1183,
    async get(path: string) {
      paths.push(path);
      return serve();
    },
  } as unknown as SchoolPassClient;
  return { client, paths };
}

describe('resolveEarlyDismissalCutoff', () => {
  it("reads the school's earlyPickup for the date's weekday", async () => {
    const { client, paths } = cutoffClient(() =>
      LIVE_CUTOFFS.map((c) => (c.day === 5 ? { ...c, earlyPickup: '1:00 PM' } : c)),
    );
    // 2026-11-20 is a Friday (day 5).
    expect(await resolveEarlyDismissalCutoff(client, '2026-11-20', {})).toEqual({ latest: '13:00', source: 'school' });
    expect(await resolveEarlyDismissalCutoff(client, '2026-11-19', {})).toEqual({ latest: '14:10', source: 'school' });
    expect(paths[0]).toBe(ENDPOINTS.cutoffTimes);
  });

  it('the school value wins over the env fallback', async () => {
    const { client } = cutoffClient(() => LIVE_CUTOFFS);
    expect(
      await resolveEarlyDismissalCutoff(client, '2026-11-20', { SCHOOLPASS_EARLY_DISMISSAL_LATEST: '13:30' }),
    ).toEqual({ latest: '14:10', source: 'school' });
  });

  it('accepts Sunday as either .NET 0 or ISO 7', async () => {
    const { client } = cutoffClient(() => [{ day: 0, earlyPickup: '11:00 AM' }]);
    expect(await resolveEarlyDismissalCutoff(client, '2026-11-22', {})).toEqual({ latest: '11:00', source: 'school' });
  });

  it('falls back to SCHOOLPASS_EARLY_DISMISSAL_LATEST when the read fails', async () => {
    const { client } = cutoffClient(() => {
      throw new Error('HTTP 403');
    });
    expect(
      await resolveEarlyDismissalCutoff(client, '2026-11-20', { SCHOOLPASS_EARLY_DISMISSAL_LATEST: '13:30' }),
    ).toEqual({ latest: '13:30', source: 'config' });
  });

  it('is unknown when the read fails and nothing is configured — no built-in guess', async () => {
    const { client } = cutoffClient(() => {
      throw new Error('HTTP 500');
    });
    expect(await resolveEarlyDismissalCutoff(client, '2026-11-20', {})).toBeUndefined();
  });

  it('falls back when the weekday has no entry or an unreadable one', async () => {
    const { client: noDay } = cutoffClient(() => LIVE_CUTOFFS); // no Saturday row
    expect(await resolveEarlyDismissalCutoff(noDay, '2026-11-21', {})).toBeUndefined();
    const { client: junk } = cutoffClient(() => [{ day: 5, earlyPickup: null }]);
    expect(await resolveEarlyDismissalCutoff(junk, '2026-11-20', {})).toBeUndefined();
    const { client: oddRows } = cutoffClient(() => [null, 'Friday', { day: 5, earlyPickup: '1:30 PM' }]);
    expect(await resolveEarlyDismissalCutoff(oddRows, '2026-11-20', {})).toEqual({ latest: '13:30', source: 'school' });
    const { client: notList } = cutoffClient(() => ({ error: 'nope' }));
    expect(await resolveEarlyDismissalCutoff(notList, '2026-11-20', {})).toBeUndefined();
  });
});
