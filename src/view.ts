import { minifiedResult, resolveView, stripMediaUrls, viewParam, type View } from '@chrischall/mcp-utils';

/**
 * The rungs this server honours (`@chrischall/mcp-utils`' `view` vocabulary;
 * `chrischall/workflows` `docs/fleet-conventions.md`, "Response shape").
 *
 * **What compact does here, and what it deliberately does NOT do.**
 *
 * The read tools in this server hand back SchoolPass's payload close to
 * verbatim, and the repo holds no verified record of what those payloads
 * contain — no captured fixture, no documented field list. So nothing here can
 * honestly say which of SchoolPass's fields matter and which are noise.
 *
 * Compact therefore does the one projection that needs no such knowledge: it
 * strips image and avatar URLs. That is SUBTRACTIVE, so it cannot lose a field
 * nobody knew about — the failure an invented field list would risk, where a
 * record comes back with holes in it and reads like a verified answer.
 *
 * When a real payload can be captured, a field projection belongs here beside
 * this one and will save considerably more. Until then this is the honest
 * ceiling, and this docblock says so rather than implying a shape was checked.
 */
export const SPS_VIEWS = ['compact', 'full'] as const;

const NOTE =
  'compact strips image/avatar URLs from the response; "full" returns SchoolPass\'s payload untouched. ' +
  'No field projection: this server has no verified record of which SchoolPass fields matter, and inventing ' +
  'one would risk dropping a field a caller needs.';

/** The `view` parameter every read tool in this server takes. */
export const viewArg = (): ReturnType<typeof viewParam> => viewParam(SPS_VIEWS, { note: NOTE });

/**
 * Keys that carry another family's contact or vehicle details. Matched only
 * INSIDE a carpool subtree (see {@link stripCarpoolContacts}).
 */
const CARPOOL_CONTACT_KEY =
  /phone|mobile|^cell|e-?mail|address|street|^city$|^state$|zip|postal|vehicle|(make|model)$|licen[cs]e|plate|colou?r/i;

/**
 * Drop contact and vehicle fields from everything under a carpool key.
 *
 * A carpool record from `parent/parentdrivers` describes OTHER parents — the
 * other members of the carpool. What the parent asking "who are my drivers"
 * needs from it is who is in the carpool, not those families' phone numbers,
 * addresses or cars. Like {@link stripMediaUrls} this is subtractive: it drops
 * only fields whose names say they are contact/vehicle data, keeps everything
 * else, and leaves the parent's own driver records (outside any carpool key)
 * alone. `full` skips it.
 */
export function stripCarpoolContacts(data: unknown, inCarpool = false): unknown {
  if (Array.isArray(data)) return data.map((d) => stripCarpoolContacts(d, inCarpool));
  if (data === null || typeof data !== 'object') return data;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (inCarpool && CARPOOL_CONTACT_KEY.test(key)) continue;
    out[key] = stripCarpoolContacts(value, inCarpool || /carpool/i.test(key));
  }
  return out;
}

/**
 * Answer in the requested rung.
 *
 * Only ever called from a READ tool. A write's response is a receipt — an id,
 * a status — with nothing to strip and everything to keep.
 */
export function viewResponse(
  view: string | undefined,
  data: unknown,
  opts: { compact?: (data: unknown) => unknown } = {},
): ReturnType<typeof minifiedResult> {
  const rung: View = resolveView(view, SPS_VIEWS);
  if (rung !== 'compact') return minifiedResult(data);
  const stripped = stripMediaUrls(data);
  return minifiedResult(opts.compact ? opts.compact(stripped) : stripped);
}
