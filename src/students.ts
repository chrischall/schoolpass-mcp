/**
 * The parent's students as display labels a caller can name a child by
 * (mcp-host spec 2026-11-03 D5: subjects are enums of LABELS, accepting label
 * or id). Listed ONCE at server start for the `student_id` enum on the student
 * reads, bounded so a host is never kept waiting on it to list tools.
 */
import { McpToolError } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { SchoolPassClient } from './client.js';
import { ENDPOINTS } from './protocol.js';

export interface StudentDirectory {
  /** One label per student, in SchoolPass's order; never empty. */
  labels: string[];
  /**
   * A label (any case, trimmed) → that student's id. A numeric id (number or
   * digit string) passes through unchanged, so a student linked after start is
   * still reachable. Anything else is refused, naming the labels.
   */
  resolve(value: string | number): number;
}

/** Bound on the start-time listing: a host must not wait on it to list tools. */
export const STUDENT_LIST_TIMEOUT_MS = 5_000;

const normal = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

interface StudentRow { id: number; name: string }

function readStudents(data: unknown): StudentRow[] {
  if (!Array.isArray(data)) return [];
  const out: StudentRow[] = [];
  for (const row of data) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = Number(r['id']);
    if (!Number.isInteger(id) || id <= 0) continue;
    const name = [r['firstName'], r['lastName']]
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      .map((v) => v.trim())
      .join(' ');
    out.push({ id, name: name || `Student ${id}` });
  }
  return out;
}

/** Map a value to a positive integer id, or undefined when it is not one. */
function asId(value: string | number): number | undefined {
  const n = typeof value === 'number' ? value : /^\s*\d+\s*$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function buildStudentDirectory(rows: StudentRow[]): StudentDirectory | null {
  if (rows.length === 0) return null;
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(normal(r.name), (counts.get(normal(r.name)) ?? 0) + 1);
  // Two students with one name would make the name ambiguous, so each carries
  // its id; every label names exactly one child.
  const labelled = rows.map((r) => ({ id: r.id, label: counts.get(normal(r.name))! > 1 ? `${r.name} (${r.id})` : r.name }));
  const byLabel = new Map(labelled.map((r) => [normal(r.label), r.id]));
  const labels = labelled.map((r) => r.label);
  return {
    labels,
    resolve(value) {
      const id = asId(value);
      if (id !== undefined) return id;
      const hit = byLabel.get(normal(String(value)));
      if (hit !== undefined) return hit;
      throw new McpToolError(`Unknown student "${value}". Known: ${labels.join(', ')}.`, {
        hint: 'Use one of those names, or a student id from schoolpass_list_students.',
      });
    },
  };
}

/**
 * List the students ONCE, at server start. Answers null — so the property is
 * published with no `enum` keyword, never an empty one — when the account has
 * no students, when the listing fails (no credentials yet, a rejected login,
 * SchoolPass down), or when it has not answered within `timeoutMs`. Never
 * throws. A rejected login is latched by the client, so this costs no second
 * sign-in attempt later.
 */
export async function loadStudentDirectory(
  client: Pick<SchoolPassClient, 'getMemberId' | 'get'>,
  timeoutMs: number = STUDENT_LIST_TIMEOUT_MS,
): Promise<StudentDirectory | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });
  const listing = (async () => {
    const memberId = await client.getMemberId();
    return buildStudentDirectory(readStudents(await client.get(ENDPOINTS.parentStudents, { memberId })));
  })().catch(() => null);
  try {
    return await Promise.race([listing, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const ID_DESCRIPTION = 'Student id, from schoolpass_list_students.';

/**
 * The `student_id` argument of a student read. With students listed at start
 * it publishes their LABELS as a JSON Schema `enum` (via `.meta`, so the
 * runtime schema still takes any string or a numeric id); without, it stays the
 * plain positive-integer id it always was.
 */
export function studentIdArg(students: StudentDirectory | null | undefined) {
  if (!students) return z.number().int().positive().describe(ID_DESCRIPTION);
  // A numeric id is turned into its digit string BEFORE validation, so the
  // published property is one plain string enum of names while a caller that
  // does not validate against it can still send the id it already holds.
  return z
    .preprocess((v) => (typeof v === 'number' ? String(v) : v), z.string().min(1))
    .meta({ enum: students.labels })
    .describe('The student, by name as listed here. A student id from schoolpass_list_students is also accepted.');
}

/** Resolve a `student_id` argument (label or id) to the numeric id SchoolPass takes. */
export function resolveStudentId(students: StudentDirectory | null | undefined, value: string | number): number {
  if (students) return students.resolve(value);
  const id = asId(value);
  if (id === undefined) throw new McpToolError(`"${value}" is not a student id.`, { hint: 'Call schoolpass_list_students.' });
  return id;
}
