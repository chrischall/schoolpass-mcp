/**
 * Arrival/dismissal read tools: a student's arrival & dismissal calendar,
 * pending pickup changes, the school's dismissal locations, and basic school
 * info. All read-only.
 *
 * The write side — submitting and cancelling a dismissal change — lives in
 * `./changes.ts`, not here: it mutates a child's real dismissal, so it is kept
 * apart from these reads, is `confirm`-gated with a dry-run preview, and
 * re-reads the day afterwards rather than trusting the submit's own success.
 */

import { IsoDate, UNTRUSTED_DESCRIPTION_SUFFIX, shiftIsoDate, toolAnnotations } from '@chrischall/mcp-utils';
import { schoolToday } from '../dates.js';
import { viewArg, viewResponse } from '../view.js';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AdType, ENDPOINTS, StudentChangeType } from '../protocol.js';
import type { SchoolPassClient } from '../client.js';
import { resolveStudentId, studentIdArg, type StudentDirectory } from '../students.js';
import { schoolMeta } from './hints.js';

const BRIEF_MAX = 120;

/** `LateArrival` → `late arrival`. */
function words(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

const SIDE: Record<number, string> = {
  [AdType.Arrival]: 'arrival',
  [AdType.Departure]: 'departure',
  [AdType.Both]: 'arrival and departure',
};

/**
 * One calendar `dailyList` entry as one line, `title — <ISO date | no date> —
 * <status>`, at most 120 characters. Built ONLY from the entry's enums and its
 * date — the change type and side as words, `default` or `changed` — never
 * from its `description`, which staff or another guardian can write: a brief
 * line is plain text a host splices into a spoken answer, so it carries no
 * third-party text to fence.
 */
export function calendarBriefLine(entry: unknown): string {
  const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
  const typeName = typeof e['studentChangeType'] === 'number' ? StudentChangeType[e['studentChangeType']] : undefined;
  const type = typeName && typeName !== 'NA' ? words(typeName) : 'no change type';
  const side = typeof e['adType'] === 'number' ? SIDE[e['adType']] : undefined;
  const title = side ? `${type} ${side}` : type;
  const stamp = typeof e['timestamp'] === 'string' ? /^\d{4}-\d{2}-\d{2}/.exec(e['timestamp'])?.[0] : undefined;
  const status = e['isDefault'] === true ? 'default' : 'changed';
  return `${title} — ${stamp ?? 'no date'} — ${status}`.slice(0, BRIEF_MAX);
}

/** The calendar's `view`: this server's rungs plus `brief`, the context-groups line view. */
const calendarViewArg = () =>
  z
    .enum(['compact', 'full', 'brief'])
    .optional()
    .describe(
      'Response shape. "compact" (default) strips image/avatar URLs; "full" returns SchoolPass\'s payload ' +
        'untouched; "brief" returns one line per day entry: <change> <side> — <YYYY-MM-DD or "no date"> — ' +
        '<default|changed>.',
    );

export function registerDismissalTools(
  server: McpServer,
  client: SchoolPassClient,
  students?: StudentDirectory | null,
): void {
  server.registerTool(
    'schoolpass_get_calendar',
    {
      description:
        'Get a student’s arrival & dismissal calendar over a date range — the per-day default and any ' +
        'changes. Requires a student id (from schoolpass_list_students). Defaults to today through 14 days out. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({
        title: 'Student calendar',
        readOnly: true,
        idempotent: true,
        openWorld: true,
      }),
      _meta: schoolMeta('whats-on', {
        canonical: true,
        subject: 'student_id',
        when: { start: 'start_date', end: 'end_date' },
        aliases: ['pickup', 'dismissal', 'carpool', 'car line', 'arrival', 'getting home', 'after school', 'school'],
      }),
      inputSchema: z.object({
        view: calendarViewArg(),
        student_id: studentIdArg(students),
        start_date: IsoDate.optional().describe('Start of range (YYYY-MM-DD). Defaults to today in the school timezone.'),
        end_date: IsoDate.optional().describe('End of range (YYYY-MM-DD). Defaults to 14 days out.'),
      }),
    },
    async ({ student_id, start_date, end_date, view }) => {
      const data = await client.get(ENDPOINTS.studentCalendar, {
        schoolCode: client.schoolCode,
        studentId: resolveStudentId(students, student_id),
        startDate: start_date ?? schoolToday(),
        endDate: end_date ?? shiftIsoDate(schoolToday(), 14),
      });
      if (view === 'brief') {
        const days = (data as { dailyList?: unknown } | undefined)?.dailyList;
        const lines = Array.isArray(days) ? days.map(calendarBriefLine) : [];
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }
      return viewResponse(view, data, { untrusted: true });
    },
  );

  server.registerTool(
    'schoolpass_list_pickup_changes',
    {
      description:
        'List pickup / dismissal changes for a student on a given date (defaults to today) — early ' +
        `pickups, late arrivals, carpool moves, and the like. Requires a student id. ${UNTRUSTED_DESCRIPTION_SUFFIX}`,
      annotations: toolAnnotations({
        title: 'List pickup changes',
        readOnly: true,
        idempotent: true,
        openWorld: true,
      }),
      _meta: schoolMeta('lookup', { subject: 'student_id', aliases: ['pickup changes', 'early pickup', 'late arrival'] }),
      inputSchema: z.object({
        view: viewArg(),
        student_id: studentIdArg(students),
        date: IsoDate.optional().describe('Date (YYYY-MM-DD). Defaults to today in the school timezone.'),
      }),
    },
    async ({ student_id, date, view }) => {
      const data = await client.get(ENDPOINTS.pickupChanges, {
        studentId: resolveStudentId(students, student_id),
        date: date ?? schoolToday(),
      });
      return viewResponse(view, data, { untrusted: true });
    },
  );

  server.registerTool(
    'schoolpass_list_dismissal_locations',
    {
      description:
        'List the school’s dismissal locations (car line, bus, aftercare, walkers, etc.) with their ids — ' +
        `the vocabulary a dismissal change refers to. ${UNTRUSTED_DESCRIPTION_SUFFIX}`,
      annotations: toolAnnotations({
        title: 'List dismissal locations',
        readOnly: true,
        idempotent: true,
        openWorld: true,
      }),
      _meta: schoolMeta('lookup', { aliases: ['dismissal locations', 'car line', 'bus', 'aftercare', 'walkers'] }),
      inputSchema: z.object({
        view: viewArg(),
      }),
    },
    async ({ view }) => viewResponse(view, await client.get(ENDPOINTS.dismissalLocations), { untrusted: true }),
  );

  server.registerTool(
    'schoolpass_get_school_info',
    {
      description:
        'Get basic school info and per-school configuration (features enabled, dismissal windows, etc.) ' +
        `for the configured school. ${UNTRUSTED_DESCRIPTION_SUFFIX}`,
      annotations: toolAnnotations({
        title: 'School info',
        readOnly: true,
        idempotent: true,
        openWorld: true,
      }),
      _meta: schoolMeta('lookup'),
      inputSchema: z.object({
        view: viewArg(),
      }),
    },
    async ({ view }) => {
      const [info, config] = await Promise.all([
        client.get(ENDPOINTS.schoolInfoBasic, { schoolCode: client.schoolCode }),
        client.get(ENDPOINTS.configSettings, { schoolCode: client.schoolCode }),
      ]);
      // Assembled from two endpoints rather than passed through from one, so it
      // offers `compact`/`full` and no `raw` rung — same as every other read
      // here. Media stripping is subtractive, so it applies to an assembled
      // record exactly as safely as to a passthrough one.
      return viewResponse(view, { schoolInfo: info, config }, { untrusted: true });
    },
  );
}
