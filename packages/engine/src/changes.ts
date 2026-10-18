import { linkKey, type Link, type LinkKey, type LinkRef } from "./links";
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

/**
 * One link change. `field: "*"` means the whole link (`before: null` = created, `after: null` =
 * deleted); `"lag"` is its only other field, since the rest identify it.
 */
export interface LinkChange {
  link: LinkRef;
  field: "*" | "lag";
  before: Link | number | null;
  after: Link | number | null;
}

export type Change = RowChange | LinkChange;

export const isLinkChange = (change: Change): change is LinkChange => "link" in change;

/** Task fields older history may still carry but rows no longer have; dependencies are links now. */
const DROPPED_FIELDS = ["predecessorId", "offset"];

/** A whole-row snapshot from a logged change, as a row of today's model. */
export function restoredRow(snapshot: unknown): Row {
  const row: Record<string, unknown> = { ...(snapshot as Record<string, unknown>) };
  for (const field of DROPPED_FIELDS) delete row[field];
  return row as unknown as Row;
}

const refOf = ({ predecessorId, followerId, kind }: LinkRef): LinkRef => ({ predecessorId, followerId, kind });

/** Field-level diff between two states: rows by row id, then links by key, for determinism. */
export function diffState(before: ProjectState, after: ProjectState): Change[] {
  const ids = [...new Set([...Object.keys(before.rows), ...Object.keys(after.rows)])].sort();
  const changes: Change[] = [];
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
  const oldLinks = before.links ?? {};
  const newLinks = after.links ?? {};
  for (const key of [...new Set([...Object.keys(oldLinks), ...Object.keys(newLinks)])].sort()) {
    const old = oldLinks[key];
    const next = newLinks[key];
    if (old === next) continue;
    if (!old || !next) {
      changes.push({ link: refOf((old ?? next)!), field: "*", before: old ?? null, after: next ?? null });
    } else if (!Object.is(old.lag, next.lag)) {
      changes.push({ link: refOf(old), field: "lag", before: old.lag, after: next.lag });
    }
  }
  return changes;
}

/** Applies changes forward (after values) or backward (before values, in reverse order). */
export function applyChanges(
  state: ProjectState,
  changes: readonly Change[],
  direction: "forward" | "backward" = "forward",
): ProjectState {
  const rows: Record<RowId, Row> = { ...state.rows };
  const links: Record<LinkKey, Link> = { ...state.links };
  const ordered = direction === "forward" ? changes : [...changes].reverse();
  for (const change of ordered) {
    const value = direction === "forward" ? change.after : change.before;
    if (isLinkChange(change)) {
      const key = linkKey(change.link);
      if (change.field === "*") {
        if (value === null) delete links[key];
        else links[key] = value as Link;
        continue;
      }
      const link = links[key];
      if (!link) throw new RangeError(`Cannot change missing link ${key}`);
      links[key] = { ...link, lag: value as number };
      continue;
    }
    if (change.field === "*") {
      if (value === null) delete rows[change.rowId];
      else rows[change.rowId] = restoredRow(value);
      continue;
    }
    const row = rows[change.rowId];
    if (!row) throw new RangeError(`Cannot change missing row ${change.rowId}`);
    rows[change.rowId] = { ...row, [change.field]: value } as Row;
  }
  return { rows, links };
}
