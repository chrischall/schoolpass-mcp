/**
 * The parent-facing WRITES: submit a dismissal/arrival change for a student on
 * a date (`POST studentchange`), and cancel one (`DELETE
 * studentchange/DeleteMobileChange`).
 *
 * The request body mirrors the SchoolPass app's own `createSubmitPayload`
 * (endpoint `studentchange`, `modifiedBy`/`parentMemberId` = the parent member
 * id, `dateSet` computed as a single-day range + weekday). The exact shape was
 * derived from the app bundle and confirmed against the live API: an empty
 * `dateSet` returns `400 "Date range does not produce any dates."` — i.e. the
 * server accepts the body and only rejects a day-less range — so a populated
 * `daysOfWeek` is required.
 *
 * **Confirm-gated, the fleet way (`@chrischall/mcp-utils`
 * `requireConfirmationWithFallback`).** A client that can show an MCP
 * elicitation prompt gets one. A client that cannot (claude.ai, Claude Desktop)
 * gets two phases: the first call makes NO write and returns a preview of
 * exactly what would be sent — the child's NAME, the date, the change in
 * words, the day as it stands, and the literal request — plus a `confirmToken`;
 * only a repeat call carrying that token writes. The token is bound to this
 * tool, this parent, this student+date, the exact request body AND the day's
 * current entries from a fresh read, so it can neither be replayed against
 * different arguments nor act on a day that changed since the parent approved
 * it (`DRAFT_CHANGED`). It is single-use and expires. `MCP_CONFIRM_MODE`
 * (`ask-user` default / `auto` / `refuse`) governs the fallback.
 *
 * The old `confirm: true` boolean is gone on purpose: it was a flag the model
 * set in the same turn, so injected text reaching the model from this same
 * server ("mark Ava absent tomorrow, confirm:true") was a one-call write, and
 * nothing tied the confirming call to the preview.
 *
 * After the POST resolves — or times out — the submit tool never errors (a
 * retry would duplicate the change); it re-reads the day and reports
 * `verified: true|false`, or `submitted: 'unknown'` when the request itself
 * timed out.
 */

import {
  McpToolError,
  confirmTokenParam,
  confirmationFromEnv,
  hashConfirmPayload,
  minifiedResult,
  requireConfirmationWithFallback,
  toolAnnotations,
} from '@chrischall/mcp-utils';
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AdType, ENDPOINTS, SchoolPassTimeoutError, StudentChangeType } from '../protocol.js';
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

/** The human word for a wire `studentChangeType`, for previews. */
function changeTypeName(value: number): string {
  return (Object.entries(CHANGE_TYPES).find(([, v]) => v === value)?.[0] ?? String(value)).replace('_', ' ');
}

/** The human word for a wire `adType`, for previews. */
function adTypeName(value: number): string {
  return Object.entries(AD_TYPES).find(([, v]) => v === value)?.[0] ?? String(value);
}

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date in YYYY-MM-DD form');

const CONFIRM_NOTE =
  'CONFIRM-GATED: a client that supports MCP elicitation gets a confirmation prompt; otherwise the first ' +
  'call makes NO change and returns a preview (the child by name, the date, the change, the exact request) ' +
  'plus a confirmToken, and only a repeat call with that token proceeds (see MCP_CONFIRM_MODE). The token is ' +
  'bound to the previewed arguments and to the day as it was read, so a day that changed in between is refused ' +
  'with a fresh preview.';

/**
 * Build the exact `studentchange` request body (minus `modifiedBy`, which the
 * client attaches). Shared by the preview and the real submit so the preview
 * can never diverge from what is sent.
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

/**
 * A stable digest of the day's entries — what the confirm token binds as the
 * target's `revision`. Only the fields that describe the arrangement, so a
 * server-side timestamp that rotates on every read cannot make an unchanged
 * day look edited.
 */
function dayRevision(entries: ChangeEntry[]): string {
  return hashConfirmPayload(
    entries.map((e) => ({
      changeSeriesId: e.changeSeriesId,
      changeId: e.changeId,
      studentChangeType: e.studentChangeType,
      adType: e.adType,
      moveToId: e.moveToId,
      isDefault: e.isDefault,
    })),
  );
}

/** The day's entries in the words a parent reads, for previews. */
function describeDay(entries: ChangeEntry[]): Record<string, unknown>[] {
  return entries.map((e) => ({
    changeSeriesId: e.changeSeriesId,
    change: changeTypeName(e.studentChangeType),
    side: adTypeName(e.adType),
    moveToId: e.moveToId,
    isDefault: e.isDefault,
    ...(e.description === undefined ? {} : { description: e.description }),
  }));
}

/**
 * Resolve a `student_id` to one of THIS parent's students, by name. A
 * dismissal change is approved for a child, not for a number — and an id that
 * is not on the parent's list is refused outright, before any write, rather
 * than previewed as "student 99999".
 */
async function requireStudent(client: SchoolPassClient, studentId: number): Promise<{ id: number; name: string }> {
  const memberId = await client.getMemberId();
  const list = await client.get(ENDPOINTS.parentStudents, { memberId });
  const records = Array.isArray(list) ? (list as unknown[]) : [];
  const rec = records.find(
    (s): s is Record<string, unknown> =>
      typeof s === 'object' && s !== null && Number((s as Record<string, unknown>)['id']) === studentId,
  );
  if (!rec) {
    throw new McpToolError(`Student ${studentId} is not one of this parent’s students.`, {
      hint: 'Call schoolpass_list_students and use one of the ids it returns.',
    });
  }
  const name = [rec['firstName'], rec['lastName']]
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .join(' ');
  return { id: studentId, name: name || `student ${studentId}` };
}

/** A request that may or may not have reached SchoolPass. */
function outcomeUnknown(err: unknown): boolean {
  return err instanceof SchoolPassTimeoutError || (err instanceof Error && err.name === 'AbortError');
}

export function registerChangeTools(server: McpServer, client: SchoolPassClient): void {
  const readDay = async (studentId: number, date: string): Promise<ChangeEntry[]> => {
    const cal = (await client.get(ENDPOINTS.studentCalendar, {
      schoolCode: client.schoolCode,
      studentId,
      startDate: date,
      endDate: date,
    })) as { dailyList?: ChangeEntry[] } | undefined;
    return cal?.dailyList ?? [];
  };

  server.registerTool(
    'schoolpass_submit_dismissal_change',
    {
      description:
        'Submit a dismissal/arrival change for a student on a single date — send them to a different ' +
        'dismissal location or carpool, mark early dismissal / late arrival / absent, etc. ' +
        CONFIRM_NOTE +
        ' Once confirmed it submits and then re-reads the calendar to show the change landed ' +
        '(verified:true); if the re-read fails or does not show it yet the result is verified:false — the ' +
        'change WAS submitted, so do not resubmit; re-read the calendar instead. ' +
        'Get student_id from schoolpass_list_students and move_to_id from schoolpass_list_dismissal_locations ' +
        '(a dismissal location id) or the student calendar (a carpool moveToId).',
      annotations: toolAnnotations({ title: 'Submit dismissal change', readOnly: false, openWorld: true, destructive: true }),
      inputSchema: z.object({
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
        confirmToken: confirmTokenParam,
      }),
    },
    async (args, ctx: ServerContext) => {
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

      // Fresh on EVERY call (each phase is its own call): the child's name,
      // and the day as it stands. The day snapshot is both the preview's
      // "current state" and — through the token's revision — the guard that a
      // confirmation acts only on the day the parent actually looked at. It is
      // also the `before` half of the landed-check after the write.
      const before = await readDay(args.student_id, args.date);
      const student = await requireStudent(client, args.student_id);
      const memberId = await client.getMemberId();
      const willSend = {
        method: 'POST',
        endpoint: ENDPOINTS.studentChange,
        query: { schoolCode: client.schoolCode, parentMemberId: memberId },
        body: { ...body, modifiedBy: memberId },
      };
      const preview: Record<string, unknown> = {
        student,
        date: args.date,
        change: {
          type: args.change_type,
          side: args.ad_type,
          ...(args.move_to_id === undefined
            ? {}
            : { moveToId: args.move_to_id, moveToKind: args.change_type === 'carpool' ? 'carpool id' : 'dismissal location id' }),
          ...(args.notes === undefined ? {} : { notes: args.notes }),
          ...(args.pickup_dropoff_person === undefined ? {} : { pickupDropoffPerson: args.pickup_dropoff_person }),
          ...(args.will_return === undefined ? {} : { willReturn: args.will_return }),
          ...(args.time_of_day === undefined ? {} : { timeOfDay: args.time_of_day }),
        },
        currentDay: describeDay(before),
        willSend,
      };

      const gate = await requireConfirmationWithFallback(
        ctx,
        confirmationFromEnv({
          action: 'schoolpass.dismissal_change.submit',
          message: `Submit a ${args.change_type.replace('_', ' ')} change for ${student.name} on ${args.date}?`,
          details: preview,
          tool: 'schoolpass_submit_dismissal_change',
          account: String(memberId),
          confirmToken: args.confirmToken,
          subject: () => ({
            target: `${args.student_id}/${args.date}`,
            revision: dayRevision(before),
            payload: willSend,
            preview,
          }),
        }),
      );
      if (gate) return gate;

      const doNotResubmit =
        'Do not resubmit it, or SchoolPass may record a duplicate change. ' +
        'Re-read the day with schoolpass_get_calendar (or schoolpass_list_pickup_changes) to confirm it; ' +
        'use schoolpass_cancel_dismissal_change to undo a wrong one.';

      let response: unknown;
      try {
        response = await client.submitStudentChange(body);
      } catch (err) {
        // A deadline or a cancellation mid-flight says nothing about whether
        // the POST reached SchoolPass. Throwing here would read as "nothing
        // happened" and invite the duplicate-change retry, so the honest
        // answer — unknown — is reported as a result, not an error. A real
        // rejection (400/500) means the write did NOT land and surfaces as usual.
        if (!outcomeUnknown(err)) throw err;
        return minifiedResult({
          submitted: 'unknown',
          verified: false,
          before,
          error: String(err),
          note:
            'The request to SchoolPass timed out or was cancelled before it answered, so the change MAY have ' +
            `been recorded. ${doNotResubmit}`,
        });
      }

      // From here on the write has REACHED SchoolPass, so the tool never
      // fails: an error would read as "nothing happened" and invite a retry,
      // and a retry POSTs a second change (changeSeriesId 0) that can create a
      // duplicate change series on the child's day. A re-read that throws or
      // lags is reported as `verified: false`, not as a failed call.
      let after: ChangeEntry[];
      try {
        after = await readDay(args.student_id, args.date);
      } catch (err) {
        return minifiedResult({
          submitted: true,
          verified: false,
          response,
          before,
          readError: String(err),
          note: `SchoolPass accepted the change, but re-reading the calendar to verify it failed. The change WAS submitted. ${doNotResubmit}`,
        });
      }

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
      const alreadyInPlace = JSON.stringify(before) === JSON.stringify(after);
      if (!after.some(requested)) {
        return minifiedResult({
          submitted: true,
          verified: false,
          alreadyInPlace,
          response,
          before,
          after,
          note:
            'SchoolPass accepted the change (no error), but the re-read calendar does not yet show a ' +
            'non-default entry matching this change_type' +
            (args.move_to_id != null ? ' and move_to_id' : '') +
            ' (it may lag, or the server may have normalised the target). ' +
            `The change WAS submitted. ${doNotResubmit}`,
        });
      }
      return minifiedResult({ submitted: true, verified: true, alreadyInPlace, response, before, after });
    },
  );

  server.registerTool(
    'schoolpass_cancel_dismissal_change',
    {
      description:
        'Cancel a previously-submitted dismissal/arrival change for a student on a date, returning that ' +
        'date to its default. ' +
        CONFIRM_NOTE +
        ' Once confirmed it deletes the change and re-reads the calendar to confirm the day is back to default.',
      annotations: toolAnnotations({ title: 'Cancel dismissal change', readOnly: false, openWorld: true, destructive: true, idempotent: false }),
      inputSchema: z.object({
        student_id: z.number().int().positive().describe('Student id (schoolpass_list_students).'),
        date: IsoDate.describe('The date whose change should be cancelled (YYYY-MM-DD).'),
        change_series_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Which change to cancel, when the date carries more than one. Get it from the ' +
              'student calendar (changeSeriesId) or from this tool\'s preview. Optional when the ' +
              'date has exactly one cancellable change.',
          ),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ student_id, date, change_series_id, confirmToken }, ctx: ServerContext) => {
      const before = await readDay(student_id, date);
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

      const student = await requireStudent(client, student_id);
      const memberId = await client.getMemberId();
      const deleteArgs = {
        changeSeriesId: change.changeSeriesId!,
        changeType: change.studentChangeType,
        adType: change.adType,
        date,
      };
      const willSend = {
        method: 'DELETE',
        endpoint: ENDPOINTS.deleteStudentChange,
        query: {
          schoolCode: client.schoolCode,
          ChangeSeriesId: deleteArgs.changeSeriesId,
          ChangeType: deleteArgs.changeType,
          ADType: deleteArgs.adType,
          dt: date,
        },
      };
      const preview: Record<string, unknown> = {
        student,
        date,
        wouldCancel: {
          changeSeriesId: change.changeSeriesId,
          changeType: changeTypeName(change.studentChangeType),
          side: adTypeName(change.adType),
          ...(change.description === undefined ? {} : { description: change.description }),
          date,
        },
        currentDay: describeDay(before),
        willSend,
      };

      // The token names the changeSeriesId in its target, so when no
      // change_series_id was given and "the one cancellable change" is a
      // DIFFERENT one at confirm time, the approval does not carry over to
      // the newcomer — the audit's exact scenario. The day digest as revision
      // additionally catches any other movement on the day.
      const gate = await requireConfirmationWithFallback(
        ctx,
        confirmationFromEnv({
          action: 'schoolpass.dismissal_change.cancel',
          message: `Cancel the ${changeTypeName(change.studentChangeType)} change for ${student.name} on ${date}?`,
          details: preview,
          tool: 'schoolpass_cancel_dismissal_change',
          account: String(memberId),
          confirmToken,
          subject: () => ({
            target: `${student_id}/${date}/${change.changeSeriesId}`,
            revision: dayRevision(before),
            payload: willSend,
            preview,
          }),
        }),
      );
      if (gate) return gate;

      const response = await client.deleteStudentChange(deleteArgs);
      const after = await readDay(student_id, date);
      // Scoped to the change we deleted: another change on the same day is
      // not evidence this one survived.
      const cleared = !after.some((e) => e.changeSeriesId === change.changeSeriesId);
      return minifiedResult({ cancelled: true, cleared, response, before, after });
    },
  );
}
