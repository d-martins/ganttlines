import type { ProjectState, Row, RowChange, RowId } from "@ganttlines/engine";
import { isDeepStrictEqual } from "node:util";

export interface Reverted {
  state: ProjectState;
  /** changes that could not be reverted because the value was changed by someone since */
  skipped: number;
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
        if (current && isDeepStrictEqual(current, expected)) removals.add(change.rowId);
        else skipped++;
      } else if (!current) {
        rows[change.rowId] = target as Row;
      } else {
        skipped++;
      }
      continue;
    }
    const value = current ? (current as unknown as Record<string, unknown>)[change.field] : undefined;
    if (current && isDeepStrictEqual(value, expected)) rows[change.rowId] = { ...current, [change.field]: target } as Row;
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
