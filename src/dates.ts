/**
 * "Today" for the school, not for the server process.
 *
 * The read tools default their date to today. Read off the process clock that
 * is the HOST's zone, and a hosted server (mcp-host) runs in UTC, so after
 * about 8pm US Eastern every default rolled over to tomorrow and a parent asking
 * for today's pickup plan got the next day's with no warning (fleet-audit#689).
 * `SCHOOLPASS_TIMEZONE` names the school's IANA zone; when it is unset the
 * local zone is used, which is right for a server running on the parent's own
 * machine.
 */

import { readEnvVar, todayIso } from '@chrischall/mcp-utils';
import { SchoolPassConfigError } from './config.js';

/** Today's date as ISO `yyyy-MM-dd` in the school's timezone. */
export function schoolToday(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): string {
  const timeZone = readEnvVar('SCHOOLPASS_TIMEZONE', { env });
  if (timeZone === undefined) return todayIso(now);
  let format: Intl.DateTimeFormat;
  try {
    // en-CA formats a date as yyyy-MM-dd.
    format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    throw new SchoolPassConfigError(
      `SCHOOLPASS_TIMEZONE must be an IANA timezone such as America/New_York (got ${JSON.stringify(timeZone)}).`,
    );
  }
  return format.format(now);
}
