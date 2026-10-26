import { isLinkChange, restoredRow, type Change } from "./changes";
import { linkKey, type Link, type LinkKey } from "./links";
import type { ProjectState, Row, RowId } from "./model";

export interface Reverted {
  state: ProjectState;
  /** changes that could not be reverted because the value was changed by someone since */
  skipped: number;
}

/** Deep equality for JSON values: plain objects are compared key by key, in any order. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameValue(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

/**
 * Undo (`direction: "undo"`) restores each change's `before` value; redo restores `after`.
 * A field is only restored while it still holds the value this command left behind, so edits
 * made since by anyone are never overwritten (skip-on-conflict). Whole rows are
 * removed only if unchanged and nothing points to them, and re-created only if absent; the same
 * goes for links, and a link they leave joining a task that no longer exists is dropped.
 */
export function revertChanges(state: ProjectState, changes: readonly Change[], direction: "undo" | "redo"): Reverted {
  const rows: Record<RowId, Row> = { ...state.rows };
  const links: Record<LinkKey, Link> = { ...state.links };
  const ordered = direction === "undo" ? [...changes].reverse() : changes;
  const removals = new Set<RowId>();
  let skipped = 0;
  for (const change of ordered) {
    const expected = direction === "undo" ? change.after : change.before;
    const target = direction === "undo" ? change.before : change.after;
    if (isLinkChange(change)) {
      const key = linkKey(change.link);
      const current = links[key];
      if (change.field === "*") {
        if (target === null) {
          if (current && sameValue(current, expected)) delete links[key];
          else skipped++;
        } else if (!current) {
          links[key] = target as Link;
        } else {
          skipped++;
        }
      } else if (current && sameValue(current.lag, expected)) {
        links[key] = { ...current, lag: target as number };
      } else {
        skipped++;
      }
      continue;
    }
    const current = rows[change.rowId];
    if (change.field === "*") {
      if (target === null) {
        // Removed together at the end, so a parent and its children (or a predecessor and the
        // follower detached by the same command) are handled as one set, whatever their order.
        if (current && sameValue(current, expected)) removals.add(change.rowId);
        else skipped++;
      } else if (!current) {
        rows[change.rowId] = restoredRow(target);
      } else {
        skipped++;
      }
      continue;
    }
    // Fields rows no longer have (from changes logged before they were dropped) are never written back.
    if (current && Object.hasOwn(current, change.field) && sameValue((current as unknown as Record<string, unknown>)[change.field], expected)) {
      rows[change.rowId] = { ...current, [change.field]: target } as Row;
    } else {
      skipped++;
    }
  }
  skipped += removeUnreferenced(rows, links, removals);
  for (const change of changes) {
    if (!isLinkChange(change)) continue;
    const key = linkKey(change.link);
    const link = links[key];
    if (!link || (rows[link.predecessorId] && rows[link.followerId])) continue;
    delete links[key];
    skipped++;
  }
  return { state: { rows, links }, skipped };
}

/**
 * Deletes the `candidates` that nothing remaining points to (a row as parent, or either end of a
 * link). A candidate that is still referenced from outside the set is kept — and so are the
 * candidates it points to. Returns how many candidates had to be kept.
 */
function removeUnreferenced(rows: Record<RowId, Row>, links: Readonly<Record<LinkKey, Link>>, candidates: Set<RowId>): number {
  const initial = candidates.size;
  const linked = new Set<RowId>();
  for (const link of Object.values(links)) linked.add(link.predecessorId).add(link.followerId);
  for (let changed = true; changed; ) {
    changed = false;
    const referenced = new Set<RowId>(linked);
    for (const row of Object.values(rows)) {
      if (candidates.has(row.id)) continue;
      if (row.parentId !== null) referenced.add(row.parentId);
    }
    for (const id of candidates) {
      if (referenced.has(id)) {
        candidates.delete(id);
        changed = true;
      }
    }
  }
  for (const id of candidates) delete rows[id];
  return initial - candidates.size;
}
