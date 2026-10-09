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
import { ENDPOINTS } from '../protocol.js';
import type { SchoolPassClient } from '../client.js';

export function registerDismissalTools(server: McpServer, client: SchoolPassClient): void {
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
      inputSchema: z.object({
        view: viewArg(),
        student_id: z.number().int().positive().describe('Student id, from schoolpass_list_students.'),
        start_date: IsoDate.optional().describe('Start of range (YYYY-MM-DD). Defaults to today in the school timezone.'),
        end_date: IsoDate.optional().describe('End of range (YYYY-MM-DD). Defaults to 14 days out.'),
      }),
    },
    async ({ student_id, start_date, end_date, view }) => {
      const data = await client.get(ENDPOINTS.studentCalendar, {
        schoolCode: client.schoolCode,
        studentId: student_id,
        startDate: start_date ?? schoolToday(),
        endDate: end_date ?? shiftIsoDate(schoolToday(), 14),
      });
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
      inputSchema: z.object({
        view: viewArg(),
        student_id: z.number().int().positive().describe('Student id, from schoolpass_list_students.'),
        date: IsoDate.optional().describe('Date (YYYY-MM-DD). Defaults to today in the school timezone.'),
      }),
    },
    async ({ student_id, date, view }) => {
      const data = await client.get(ENDPOINTS.pickupChanges, {
        studentId: student_id,
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
