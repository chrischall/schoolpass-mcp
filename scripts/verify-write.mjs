#!/usr/bin/env node
/**
 * One-time, self-reverting live verification of the dismissal-change WRITE.
 * Not part of `npm test`; nothing in CI runs it. Run manually, once:
 *
 *   npm run build && node --env-file=.env scripts/verify-write.mjs
 *
 * SAFETY: it submits a MarkAsAbsent change on a date ~21 days out — the app's
 * own default action, which moves the student nowhere (it only flags absent for
 * that future date). It then deletes the change and re-reads to confirm the day
 * is back to all-default. Even if the delete failed, the only effect is a single
 * future date flagged absent, which is visible in the app and trivially cleared.
 * All output goes to stdout.
 *
 * Purpose: prove the corrected body (endpoint `studentchange`, `modifiedBy` /
 * `parentMemberId`, populated `dateSet.daysOfWeek`, the E2 changeType enum and
 * the app's adType init) returns a real 2xx and that the change lands + reverts
 * — the one thing unit tests cannot prove.
 */
import { SchoolPassClient } from '../dist/client.js';
import { buildChangeBody } from '../dist/tools/changes.js';
import { StudentChangeType, AdType } from '../dist/protocol.js';

const log = (...a) => console.log(...a);
const c = new SchoolPassClient();
const mid = await c.getMemberId();
const students = await c.get('parent/getstudents', { memberId: mid });
const student = students[0];

const d = new Date();
d.setDate(d.getDate() + 21);
while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
const date = d.toISOString().slice(0, 10);

// Shape-only summary: this script runs against a REAL child's calendar, so it
// prints structure and ids rather than names, notes or free text — the same
// posture scripts/live-check.mjs takes.
const summarize = (entries) =>
  (entries ?? []).map((e) => ({
    changeTypeId: e.changeTypeId ?? null,
    adType: e.adType ?? null,
    moveToId: e.moveToId ?? null,
    isDefault: e.isDefault ?? null,
    changeSeriesId: e.changeSeriesId ?? null,
  }));

const readDay = async () => {
  const cal = await c.get('Student/StudentCalendar', {
    schoolCode: c.schoolCode, studentId: student.id, startDate: date, endDate: date,
  });
  return cal?.dailyList ?? [];
};

log(`Verifying write for student id ${student.id} on ${date}`);
const pre = await readDay();
log('PRE (default):', summarize(pre));

// MarkAsAbsent — the app's default, target-less action. The app's adType
// initializes to Departure (3) and stays there for absent.
const body = buildChangeBody({
  studentId: student.id,
  date,
  changeType: StudentChangeType.Absent,
  adType: AdType.Departure,
  notes: 'SchoolPass MCP write verification — will be deleted',
});

let ok = false;
try {
  const res = await c.submitStudentChange(body);
  log('SUBMIT 2xx: response received:', res == null ? 'null' : typeof res);
  ok = true;
} catch (e) {
  log('SUBMIT FAILED:', e.message);
}

const post = await readDay();
const change = post.find((e) => e.isDefault === false || e.changeId != null || e.changeSeriesId != null);
log('POST:', summarize(post));
log('change recorded?', !!change);

// Restore: delete the change series, then revert to carpool as a backstop.
if (change?.changeSeriesId != null) {
  try {
    await c.request('DELETE', 'studentchange/DeleteMobileChange', {
      query: { schoolCode: c.schoolCode, ChangeSeriesId: change.changeSeriesId, ChangeType: StudentChangeType.Absent, ADType: AdType.Departure, dt: date },
    });
    log('deleted change series', change.changeSeriesId);
  } catch (e) {
    log('delete note:', e.message);
  }
}
try {
  await c.post('PickupChange/revertToCarpool', undefined, { studentId: student.id, date });
  log('reverted via revertToCarpool (backstop)');
} catch (e) {
  log('revert note:', e.message);
}

const fin = await readDay();
const restored = fin.length > 0 && fin.every((e) => e.isDefault === true);
log('FINAL restored to all-default?', restored);
log(ok && restored ? '\n✅ WRITE VERIFIED — a real change was accepted and the day was restored to default.' : ok ? '\n⚠️ Submitted, but CHECK the restore above.' : '\n❌ Submit failed — see SUBMIT FAILED above.');
process.exit(ok && restored ? 0 : 1);
