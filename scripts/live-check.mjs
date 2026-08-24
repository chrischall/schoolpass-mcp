#!/usr/bin/env node
/**
 * Manual live check against the REAL SchoolPass API. Not part of `npm test`;
 * nothing in CI runs it.
 *
 *   npm run build && node --env-file=.env scripts/live-check.mjs
 *
 * Needs SCHOOLPASS_EMAIL / SCHOOLPASS_PASSWORD / SCHOOLPASS_SCHOOL_CODE in the
 * environment (or .env). It makes READ calls only and never submits a change —
 * it exists to pin the auth-response envelope and confirm which parent-scoped
 * endpoints a real parent token can actually reach.
 *
 * It prints the SHAPE of each response (top-level keys / array element keys),
 * never raw values, so a token or PII never lands in the terminal.
 *
 * Exit code 0 = login worked and at least the students read succeeded.
 */

import { SchoolPassClient } from '../dist/client.js';
import { fetchIdentities } from '../dist/auth.js';
import { resolveConfig } from '../dist/config.js';

/** Structural fingerprint of a value — keys only, recursively one level. */
function shape(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? [`[${v.length}]`, shape(v[0], depth)] : '[]';
  if (typeof v === 'object') {
    if (depth > 1) return '{…}';
    return Object.fromEntries(Object.keys(v).map((k) => [k, typeofOrShape(v[k], depth + 1)]));
  }
  return typeof v;
}
function typeofOrShape(v, depth) {
  if (v && typeof v === 'object') return shape(v, depth);
  return typeof v;
}

let failures = 0;
function ok(label, detail) {
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}
function fail(label, detail) {
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  failures += 1;
}

let config;
try {
  config = resolveConfig();
} catch (err) {
  console.error(`Not configured: ${err.message}`);
  process.exit(2);
}

console.log(`SchoolPass live check — school ${config.schoolCode} @ ${config.apiHost}\n`);

const client = new SchoolPassClient();

// 1. Auth bootstrap + identity shape.
try {
  const identities = await fetchIdentities(config);
  console.log('  Auth/users element shape:', JSON.stringify(shape(identities)));
  const id = await client.getIdentity();
  ok('login', `parent memberId=${id.userId} userType=${id.userType}`);
} catch (err) {
  fail('login', err.message);
  process.exit(1);
}

// 2. Reads. Each prints its shape; a 403 is recorded (admin-only, expected).
const reads = [
  ['students', async () => client.get('parent/getstudents', { memberId: await client.getMemberId() })],
  ['profile', async () => client.get('parent/profile', { memberId: await client.getMemberId() })],
  ['drivers', async () =>
    client.get('parent/parentdrivers', { memberId: await client.getMemberId(), includeCarpool: true })],
  ['dismissalLocations', () => client.get('dismissal/getDismissalLocations')],
  ['schoolInfo', () => client.get('SchoolInfo/GetBasicSchoolInfo', { schoolCode: client.schoolCode })],
];

let firstStudentId;
for (const [label, run] of reads) {
  try {
    const data = await run();
    if (label === 'students' && Array.isArray(data) && data[0]) firstStudentId = data[0].id;
    console.log(`  ${label} shape:`, JSON.stringify(shape(data)));
    ok(label);
  } catch (err) {
    // 403 = the parent token cannot reach this route; note it, do not fail hard.
    const is403 = /HTTP 403/.test(err.message);
    (is403 ? ok : fail)(label, is403 ? '403 (not parent-authorized)' : err.message);
  }
}

// 3. Student-scoped reads, if we found a student.
if (firstStudentId !== undefined) {
  const today = new Date().toISOString().slice(0, 10);
  for (const [label, run] of [
    ['calendar', () =>
      client.get('Student/StudentCalendar', {
        schoolCode: client.schoolCode,
        studentId: firstStudentId,
        startDate: today,
        endDate: today,
      })],
    ['pickupChanges', () => client.get('PickupChange/GetChanges', { studentId: firstStudentId, date: today })],
  ]) {
    try {
      const data = await run();
      console.log(`  ${label} shape:`, JSON.stringify(shape(data)));
      ok(label);
    } catch (err) {
      const is403 = /HTTP 403/.test(err.message);
      (is403 ? ok : fail)(label, is403 ? '403 (not parent-authorized)' : err.message);
    }
  }
} else {
  console.log('  (no students returned — skipping student-scoped reads)');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
