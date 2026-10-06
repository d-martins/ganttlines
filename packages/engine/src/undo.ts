import type { RowChange } from "./changes";
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
 * removed only if unchanged and nothing points to them, and re-created only if absent.
 */
export function revertChanges(state: ProjectState, changes: readonly RowChange[], direction: "undo" | "redo"): Reverted {
  const rows: Record<RowId, Row> = { ...state.rows };
  const ordered = direction === "undo" ? [...changes].reverse() : changes;
  const removals = new Set<RowId>();
  let skipped = 0;
  for (const change of ordered) {
    const expected = direction === "undo" ? change.after : change.before;
    const target = direction === "undo" ? change.before : change.after;
    const current = rows[change.rowId];
    if (change.field === "*") {
      if (target === null) {
        // Removed together at the end, so a parent and its children (or a predecessor and the
        // successor detached by the same command) are handled as one set, whatever their order.
        if (current && sameValue(current, expected)) removals.add(change.rowId);
        else skipped++;
      } else if (!current) {
        rows[change.rowId] = target as Row;
      } else {
        skipped++;
      }
      continue;
    }
    const value = current ? (current as unknown as Record<string, unknown>)[change.field] : undefined;
    if (current && sameValue(value, expected)) rows[change.rowId] = { ...current, [change.field]: target } as Row;
    else skipped++;
  }
  skipped += removeUnreferenced(rows, removals);
  return { state: { rows }, skipped };
}

/**
 * Deletes the `candidates` that no remaining row points to (as parent or predecessor). A candidate
 * that is still referenced from outside the set is kept — and so are the candidates it points to.
 * Returns how many candidates had to be kept.
 */
function removeUnreferenced(rows: Record<RowId, Row>, candidates: Set<RowId>): number {
  const initial = candidates.size;
  for (let changed = true; changed; ) {
    changed = false;
    const referenced = new Set<RowId>();
    for (const row of Object.values(rows)) {
      if (candidates.has(row.id)) continue;
      if (row.parentId !== null) referenced.add(row.parentId);
      if (row.kind === "task" && row.predecessorId !== null) referenced.add(row.predecessorId);
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
