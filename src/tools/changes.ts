/**
 * The one parent-facing WRITE: submit a dismissal/arrival change for a student
 * on a date (`POST studentchange`).
 *
 * The request body mirrors the SchoolPass app's own `createSubmitPayload`
 * (endpoint `studentchange`, `modifiedBy`/`parentMemberId` = the parent member
 * id, `dateSet` computed as a single-day range + weekday). The exact shape was
 * derived from the app bundle and confirmed against the live API: an empty
 * `dateSet` returns `400 "Date range does not produce any dates."` — i.e. the
 * server accepts the body and only rejects a day-less range — so a populated
 * `daysOfWeek` is required.
 *
 * **Confirm-gated.** Without `confirm: true` the tool makes NO network call and
 * returns a dry-run `preview` of exactly what would be sent. With `confirm:
 * true` it submits, then re-reads the student's calendar for the date and
 * returns before/after so the caller can see the change actually landed — a
 * `200` alone is not treated as proof.
 */

import { McpToolError, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AdType, ENDPOINTS, StudentChangeType } from '../protocol.js';
import type { SchoolPassClient } from '../client.js';

/**
 * Day-of-week id the API expects in `dateSet.daysOfWeek`, matching the app's
 * own day list: **Monday=1 … Sunday=7** (ISO-8601 weekday numbering). The app
 * sends these ids as NUMBERS, not the string names the Swagger enum implies —
 * sending `"Monday"` returns a 500.
 */
export function dayOfWeekId(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay(); // 0=Sun … 6=Sat
  return dow === 0 ? 7 : dow;
}

const CHANGE_TYPES = {
  absent: StudentChangeType.Absent,
  late_arrival: StudentChangeType.LateArrival,
  early_dismissal: StudentChangeType.EarlyDismissal,
  carpool: StudentChangeType.Carpool,
  activity: StudentChangeType.Activity,
  bus: StudentChangeType.Bus,
  virtual: StudentChangeType.Virtual,
} as const;

const AD_TYPES = {
  arrival: AdType.Arrival,
  departure: AdType.Departure,
  both: AdType.Both,
} as const;

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date in YYYY-MM-DD form');

/**
 * Build the exact `studentchange` request body (minus `modifiedBy`, which the
 * client attaches). Shared by the dry-run preview and the real submit so the
 * preview can never diverge from what is sent.
 */
export function buildChangeBody(args: {
  studentId: number;
  date: string;
  changeType: number;
  adType: number;
  moveToId?: number;
  busStopId?: number;
  notes?: string;
  pickupDropoffPerson?: string;
  willReturn?: boolean;
  timeOfDay?: string;
}): Record<string, unknown> {
  return {
    studentId: args.studentId,
    moveToId: args.moveToId ?? null,
    busStopId: args.busStopId ?? null,
    // Matches the app's createSubmitPayload EXACTLY: `dates` is EMPTY and the
    // day is selected by a single-day range + its weekday in `daysOfWeek`.
    // Populating `dates` 500s; an empty `daysOfWeek` 400s ("no dates").
    dateSet: {
      dates: [],
      daysOfWeek: [dayOfWeekId(args.date)],
      startDate: args.date,
      endDate: args.date,
      recurringWeeks: 0,
    },
    notes: args.notes ?? '',
    pickupDropoffPerson: args.pickupDropoffPerson ?? null,
    willReturn: args.willReturn ?? false,
    timeOfDay: args.timeOfDay ?? null,
    changeSeriesId: 0,
    changeType: args.changeType,
    adType: args.adType,
    userType: 3, // Parent
  };
}

export function registerChangeTools(server: McpServer, client: SchoolPassClient): void {
  server.registerTool(
    'schoolpass_submit_dismissal_change',
    {
      description:
        'Submit a dismissal/arrival change for a student on a single date — send them to a different ' +
        'dismissal location or carpool, mark early dismissal / late arrival / absent, etc. ' +
        'CONFIRM-GATED: without confirm:true it makes no change and returns a dry-run preview of the exact ' +
        'request. With confirm:true it submits and then re-reads the calendar to show the change landed. ' +
        'Get student_id from schoolpass_list_students and move_to_id from schoolpass_list_dismissal_locations ' +
        '(a dismissal location id) or the student calendar (a carpool moveToId).',
      annotations: toolAnnotations({ title: 'Submit dismissal change', readOnly: false, openWorld: true }),
      inputSchema: {
        student_id: z.number().int().positive().describe('Student id (schoolpass_list_students).'),
        date: IsoDate.describe('The date to change (YYYY-MM-DD).'),
        change_type: z
          .enum(['absent', 'late_arrival', 'early_dismissal', 'carpool', 'activity', 'bus', 'virtual'])
          .describe('The kind of change.'),
        ad_type: z
          .enum(['arrival', 'departure', 'both'])
          .default('departure')
          .describe('Which side of the day: arrival, departure (default), or both.'),
        move_to_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Target dismissal location id (schoolpass_list_dismissal_locations) or carpool id. ' +
              'Required for carpool and bus moves (enforced); supply it for activity/location moves too.',
          ),
        bus_stop_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Bus stop id for a bus move. The app sends this field on every submit, but no bus ' +
              'change has been captured live, so its effect is UNVERIFIED — see docs/SCHOOLPASS-API.md.',
          ),
        notes: z.string().optional().describe('Optional note attached to the change.'),
        pickup_dropoff_person: z.string().optional().describe('Optional name of the person picking up / dropping off.'),
        will_return: z.boolean().optional().describe('Whether the student will return the same day (for early dismissal).'),
        time_of_day: z.string().optional().describe('Optional time of day for the change (e.g. "14:30").'),
        confirm: z
          .boolean()
          .optional()
          .describe('Must be true to actually submit. Without it, returns a dry-run preview only.'),
      },
    },
    async (args) => {
      // The description promises move_to_id is required for these; enforce it
      // here rather than letting the server 500 or, worse, silently store a
      // move with no target. Only the two the captured docs name explicitly are
      // enforced — `activity` is left optional because no capture confirms it
      // needs one, and a wrong refusal is as bad as a wrong write.
      if ((args.change_type === 'carpool' || args.change_type === 'bus') && args.move_to_id == null) {
        throw new McpToolError(`move_to_id is required for a ${args.change_type} change.`, {
          hint:
            args.change_type === 'carpool'
              ? 'Pass the carpool id (from the student calendar\'s moveToId) — for a carpool move this is a carpool id, NOT a dismissal location id.'
              : 'Pass the target id for the bus move (schoolpass_list_dismissal_locations).',
        });
      }

      const changeType = CHANGE_TYPES[args.change_type];
      const adType = AD_TYPES[args.ad_type];
      const body = buildChangeBody({
        studentId: args.student_id,
        date: args.date,
        changeType,
        adType,
        moveToId: args.move_to_id,
        busStopId: args.bus_stop_id,
        notes: args.notes,
        pickupDropoffPerson: args.pickup_dropoff_person,
        willReturn: args.will_return,
        timeOfDay: args.time_of_day,
      });

      if (args.confirm !== true) {
        return minifiedResult({
          dryRun: true,
          willSend: {
            method: 'POST',
            endpoint: ENDPOINTS.studentChange,
            query: { schoolCode: client.schoolCode, parentMemberId: '<parent member id>' },
            body: { ...body, modifiedBy: '<parent member id>' },
          },
          note: 'No change was submitted. Call again with confirm:true to apply it.',
        });
      }

      // Snapshot the day before the write, so the response proves the change.
      const readDay = async () => {
        const cal = (await client.get(ENDPOINTS.studentCalendar, {
          schoolCode: client.schoolCode,
          studentId: args.student_id,
          startDate: args.date,
          endDate: args.date,
        })) as { dailyList?: ChangeEntry[] } | undefined;
        return cal?.dailyList ?? [];
      };
      const before = await readDay();
      const response = await client.submitStudentChange(body);
      const after = await readDay();

      // docs/SCHOOLPASS-API.md states the proof: "confirm a non-default entry
      // (isDefault:false, a populated changeSeriesId) appeared". Verify by
      // PRESENCE of the change we asked for, not by a before/after diff — a
      // diff reports failure for an idempotent re-submit, where the day is
      // already in the requested state and nothing moves. The diff is still
      // reported, as `alreadyInPlace`, because "it was already like this" and
      // "we just changed it" are different answers for a caller.
      const requested = (e: ChangeEntry): boolean =>
        e.isDefault === false &&
        e.changeSeriesId != null &&
        e.studentChangeType === changeType &&
        (args.move_to_id == null || e.moveToId === args.move_to_id);
      const landed = (after as ChangeEntry[]).some(requested);
      if (!landed) {
        throw new McpToolError(
          'SchoolPass accepted the change (no error) but the requested change is not on the calendar for that date.',
          {
            hint:
              'The submit returned success, but re-reading the day shows no non-default entry matching this change_type' +
              (args.move_to_id != null ? ' and move_to_id' : '') +
              ' — verify the student id, date, and move_to_id.',
          },
        );
      }
      const alreadyInPlace = JSON.stringify(before) === JSON.stringify(after);
      return minifiedResult({ submitted: true, alreadyInPlace, response, before, after });
    },
  );

  server.registerTool(
    'schoolpass_cancel_dismissal_change',
    {
      description:
        'Cancel a previously-submitted dismissal/arrival change for a student on a date, returning that ' +
        'date to its default. CONFIRM-GATED: without confirm:true it looks up the change and returns a ' +
        'preview of what would be cancelled, making no change. With confirm:true it deletes the change and ' +
        're-reads the calendar to confirm the day is back to default.',
      annotations: toolAnnotations({ title: 'Cancel dismissal change', readOnly: false, openWorld: true }),
      inputSchema: {
        student_id: z.number().int().positive().describe('Student id (schoolpass_list_students).'),
        date: IsoDate.describe('The date whose change should be cancelled (YYYY-MM-DD).'),
        change_series_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Which change to cancel, when the date carries more than one. Get it from the ' +
              'student calendar (changeSeriesId) or from this tool\'s dry-run. Optional when the ' +
              'date has exactly one cancellable change.',
          ),
        confirm: z
          .boolean()
          .optional()
          .describe('Must be true to actually cancel. Without it, returns a preview only.'),
      },
    },
    async ({ student_id, date, change_series_id, confirm }) => {
      const readDay = async () => {
        const cal = (await client.get(ENDPOINTS.studentCalendar, {
          schoolCode: client.schoolCode,
          studentId: student_id,
          startDate: date,
          endDate: date,
        })) as { dailyList?: ChangeEntry[] } | undefined;
        return cal?.dailyList ?? [];
      };

      const before = await readDay();
      const cancellable = before.filter((e) => e.isDefault === false && e.changeSeriesId != null);
      if (cancellable.length === 0) {
        throw new McpToolError(`No cancellable change found for student ${student_id} on ${date}.`, {
          hint: 'The date already shows only default entries — there is nothing to cancel.',
        });
      }

      let change: ChangeEntry;
      if (change_series_id != null) {
        const target = cancellable.find((e) => e.changeSeriesId === change_series_id);
        if (!target) {
          throw new McpToolError(
            `No cancellable change with changeSeriesId ${change_series_id} for student ${student_id} on ${date}.`,
            {
              hint: `That date carries: ${cancellable
                .map((e) => `${e.changeSeriesId} (type ${e.studentChangeType}, adType ${e.adType})`)
                .join('; ')}.`,
            },
          );
        }
        change = target;
      } else if (cancellable.length > 1) {
        // Deleting "the first one" would be a coin flip against a child's real
        // dismissal, so an ambiguous date is refused rather than guessed.
        throw new McpToolError(
          `Student ${student_id} has ${cancellable.length} cancellable changes on ${date} — say which one.`,
          {
            hint: `Pass change_series_id. Candidates: ${cancellable
              .map((e) => `${e.changeSeriesId} (type ${e.studentChangeType}, adType ${e.adType})`)
              .join('; ')}.`,
          },
        );
      } else {
        change = cancellable[0]!;
      }

      if (confirm !== true) {
        return minifiedResult({
          dryRun: true,
          wouldCancel: {
            changeSeriesId: change.changeSeriesId,
            changeType: change.studentChangeType,
            adType: change.adType,
            description: change.description,
            date,
          },
          note: 'No change was cancelled. Call again with confirm:true to cancel it.',
        });
      }

      const response = await client.deleteStudentChange({
        changeSeriesId: change.changeSeriesId!,
        changeType: change.studentChangeType,
        adType: change.adType,
        date,
      });
      const after = await readDay();
      // Scoped to the change we deleted: another change on the same day is
      // not evidence this one survived.
      const cleared = !after.some((e) => e.changeSeriesId === change.changeSeriesId);
      return minifiedResult({ cancelled: true, cleared, response, before, after });
    },
  );
}

/** The calendar `dailyList` entry shape (the fields this file reads). */
interface ChangeEntry {
  changeSeriesId: number | null;
  changeId: number | null;
  moveToId: number | null;
  studentChangeType: number;
  adType: number;
  isDefault: boolean;
  description?: string;
  timestamp: string;
}
