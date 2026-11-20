/**
 * The latest pickup time SchoolPass accepts for an early dismissal.
 *
 * SchoolPass rejects an early dismissal whose requested pickup time is later
 * than the school's per-weekday `earlyPickup` cutoff, with
 * `HTTP 400 "This change is after the cutoff time and will not be accepted.
 * Please contact the school."` The wording reads like a SUBMISSION deadline,
 * but it is not: on 2026-11-20 a 14:30 early dismissal was refused at 7:04 AM
 * while 14:00 for the same day went through. The limit is on the pickup time.
 *
 * The school publishes the limit at `GET v1/admin/cutofftimes` — despite the
 * admin path, a parent token reads it (verified live, school 1183):
 * `[{ day: 1, earlyPickup: "2:10 PM", pmCutoff: "2:55 PM", amCutoff: "7:00 AM" }, …]`.
 * That is the first source. When it cannot be read (403 for another school's
 * policy, an outage, no row for the weekday, an unreadable value) the server
 * falls back to `SCHOOLPASS_EARLY_DISMISSAL_LATEST` (HH:MM) if set. There is
 * deliberately NO built-in value: a cutoff is per school and changeable, so a
 * baked-in guess would be wrong somewhere. With neither, the cutoff is
 * unknown and the up-front check is skipped — SchoolPass still enforces its
 * own value, and its 400 is translated either way.
 */

import { McpToolError, readEnvVar } from '@chrischall/mcp-utils';
import type { SchoolPassClient } from './client.js';
import { ENDPOINTS } from './protocol.js';

/** Where a cutoff came from: the school's live setting, or the env var. */
export type CutoffSource = 'school' | 'config';

export interface EarlyDismissalCutoff {
  /** Latest allowed pickup time, 24-hour `HH:MM`. */
  latest: string;
  source: CutoffSource;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Minutes after midnight for a strict 24-hour `HH:MM`, or `null`. Strict on
 * purpose: `time_of_day` goes to SchoolPass verbatim, and only `HH:MM` has
 * been seen accepted live, so "2:30 PM" or "1430" is refused rather than sent.
 */
export function parseTimeOfDay(raw: string): number | null {
  const m = HHMM.exec(raw);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Normalise a clock value as SchoolPass stores it (`"2:10 PM"`) — or a 24-hour
 * `HH:MM` — to `HH:MM`. `null` for anything else.
 */
export function parseSchoolClock(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (HHMM.test(s)) return s;
  const m = /^(\d{1,2}):([0-5]\d)\s*([AaPp])\.?[Mm]\.?$/.exec(s);
  if (!m) return null;
  const h12 = Number(m[1]);
  if (h12 < 1 || h12 > 12) return null;
  const h = (h12 % 12) + (m[3]!.toLowerCase() === 'p' ? 12 : 0);
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** The fallback cutoff: `SCHOOLPASS_EARLY_DISMISSAL_LATEST` if set, else unknown. */
export function earlyDismissalLatestFromEnv(env: NodeJS.ProcessEnv = process.env): EarlyDismissalCutoff | undefined {
  const raw = readEnvVar('SCHOOLPASS_EARLY_DISMISSAL_LATEST', { env });
  if (raw === undefined) return undefined;
  if (parseTimeOfDay(raw) === null) {
    throw new McpToolError(
      `SCHOOLPASS_EARLY_DISMISSAL_LATEST must be a 24-hour HH:MM time (got ${JSON.stringify(raw)}).`,
      { hint: 'Fix or unset SCHOOLPASS_EARLY_DISMISSAL_LATEST.' },
    );
  }
  return { latest: raw, source: 'config' };
}

/** ISO weekday (Monday=1 … Sunday=7) of a `YYYY-MM-DD` date. */
function isoWeekday(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/**
 * The early-dismissal cutoff that applies to `date`: the school's live
 * `earlyPickup` for that weekday, else the env fallback, else `undefined`.
 */
export async function resolveEarlyDismissalCutoff(
  client: SchoolPassClient,
  date: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EarlyDismissalCutoff | undefined> {
  try {
    const rows = await client.get(ENDPOINTS.cutoffTimes, { schoolCode: client.schoolCode });
    if (Array.isArray(rows)) {
      const weekday = isoWeekday(date);
      // `day` is .NET DayOfWeek (Sunday=0 … Saturday=6); Monday–Saturday
      // agree with ISO, so only Sunday needs both spellings.
      const row = rows.find((r): r is Record<string, unknown> => {
        if (typeof r !== 'object' || r === null) return false;
        const day = Number((r as Record<string, unknown>)['day']);
        return day === weekday || (weekday === 7 && day === 0);
      });
      const latest = parseSchoolClock(row?.['earlyPickup']);
      if (latest !== null) return { latest, source: 'school' };
    }
  } catch {
    // Unreadable school setting: the fallback below still guards the write,
    // and SchoolPass's own 400 is translated if it disagrees.
  }
  return earlyDismissalLatestFromEnv(env);
}
