import type { ProjectState, Row, RowId } from "./model";

/**
 * One stored-field change. `field: "*"` means the whole row: `before: null` = created,
 * `after: null` = deleted. Computed dates are never part of changes.
 */
export interface RowChange {
  rowId: RowId;
  field: string;
  before: unknown;
  after: unknown;
}

/** Field-level diff between two states, ordered by row id for determinism. */
export function diffRows(before: ProjectState, after: ProjectState): RowChange[] {
  const ids = [...new Set([...Object.keys(before.rows), ...Object.keys(after.rows)])].sort();
  const changes: RowChange[] = [];
  for (const rowId of ids) {
    const old = before.rows[rowId];
    const next = after.rows[rowId];
    if (old === next) continue;
    if (!old || !next) {
      changes.push({ rowId, field: "*", before: old ?? null, after: next ?? null });
      continue;
    }
    const oldFields = old as unknown as Record<string, unknown>;
    const newFields = next as unknown as Record<string, unknown>;
    for (const field of Object.keys(newFields)) {
      if (!Object.is(oldFields[field], newFields[field])) {
        changes.push({ rowId, field, before: oldFields[field], after: newFields[field] });
      }
    }
  }
  return changes;
}

/** Applies changes forward (after values) or backward (before values, in reverse order). */
export function applyChanges(
  state: ProjectState,
  changes: readonly RowChange[],
  direction: "forward" | "backward" = "forward",
): ProjectState {
  const rows: Record<RowId, Row> = { ...state.rows };
  const ordered = direction === "forward" ? changes : [...changes].reverse();
  for (const change of ordered) {
    const value = direction === "forward" ? change.after : change.before;
    if (change.field === "*") {
      if (value === null) delete rows[change.rowId];
      else rows[change.rowId] = value as Row;
      continue;
    }
    const row = rows[change.rowId];
    if (!row) throw new RangeError(`Cannot change missing row ${change.rowId}`);
    rows[change.rowId] = { ...row, [change.field]: value } as Row;
  }
  return { rows };
}
