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

import { minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import { viewArg, viewResponse } from '../view.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ENDPOINTS } from '../protocol.js';
import type { SchoolPassClient } from '../client.js';

/** `YYYY-MM-DD` today, in the server's local zone. */
function today(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** `YYYY-MM-DD` N days from today. */
function daysFromToday(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date in YYYY-MM-DD form');

export function registerDismissalTools(server: McpServer, client: SchoolPassClient): void {
  server.registerTool(
    'schoolpass_get_calendar',
    {
      description:
        'Get a student’s arrival & dismissal calendar over a date range — the per-day default and any ' +
        'changes. Requires a student id (from schoolpass_list_students). Defaults to today through 14 days out.',
      annotations: toolAnnotations({
        title: 'Student calendar',
        readOnly: true,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: {
        view: viewArg(),
        student_id: z.number().int().positive().describe('Student id, from schoolpass_list_students.'),
        start_date: IsoDate.optional().describe('Start of range (YYYY-MM-DD). Defaults to today.'),
        end_date: IsoDate.optional().describe('End of range (YYYY-MM-DD). Defaults to 14 days out.'),
      },
    },
    async ({ student_id, start_date, end_date, view }) => {
      const data = await client.get(ENDPOINTS.studentCalendar, {
        schoolCode: client.schoolCode,
        studentId: student_id,
        startDate: start_date ?? today(),
        endDate: end_date ?? daysFromToday(14),
      });
      return viewResponse(view, data);
    },
  );

  server.registerTool(
    'schoolpass_list_pickup_changes',
    {
      description:
        'List pickup / dismissal changes for a student on a given date (defaults to today) — early ' +
        'pickups, late arrivals, carpool moves, and the like. Requires a student id.',
      annotations: toolAnnotations({
        title: 'List pickup changes',
        readOnly: true,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: {
        view: viewArg(),
        student_id: z.number().int().positive().describe('Student id, from schoolpass_list_students.'),
        date: IsoDate.optional().describe('Date (YYYY-MM-DD). Defaults to today.'),
      },
    },
    async ({ student_id, date, view }) => {
      const data = await client.get(ENDPOINTS.pickupChanges, {
        studentId: student_id,
        date: date ?? today(),
      });
      return viewResponse(view, data);
    },
  );

  server.registerTool(
    'schoolpass_list_dismissal_locations',
    {
      description:
        'List the school’s dismissal locations (car line, bus, aftercare, walkers, etc.) with their ids — ' +
        'the vocabulary a dismissal change refers to.',
      annotations: toolAnnotations({
        title: 'List dismissal locations',
        readOnly: true,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: {},
    },
    async () => minifiedResult(await client.get(ENDPOINTS.dismissalLocations)),
  );

  server.registerTool(
    'schoolpass_get_school_info',
    {
      description:
        'Get basic school info and per-school configuration (features enabled, dismissal windows, etc.) ' +
        'for the configured school.',
      annotations: toolAnnotations({
        title: 'School info',
        readOnly: true,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: {},
    },
    async () => {
      const [info, config] = await Promise.all([
        client.get(ENDPOINTS.schoolInfoBasic, { schoolCode: client.schoolCode }),
        client.get(ENDPOINTS.configSettings, { schoolCode: client.schoolCode }),
      ]);
      return minifiedResult({ schoolInfo: info, config });
    },
  );
}
