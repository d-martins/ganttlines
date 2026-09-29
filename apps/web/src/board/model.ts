import { computeSchedule, CycleError, toDay, type Calendar, type ProjectState, type RowId, type Span } from "@ganttlines/engine";
import type { BaselineTaskDto } from "@ganttlines/protocol";
import { outline, type ListRow } from "./rows";

export type DrawKind = "task" | "milestone" | "parent" | "section";
export type CompareMode = "overlay" | "switch";

export interface Ghost {
  kind: BaselineTaskDto["kind"];
  span: Span;
}

export interface BoardRow extends ListRow {
  /** dates to draw (the baseline's own when viewing one) */
  span: Span | null;
  kind: DrawKind;
  /** a locked task starts before its predecessor allows */
  violation: boolean;
  /** the baseline's dates under the live bar (overlay mode) */
  ghost: Ghost | null;
}

export interface BoardModel {
  rows: BoardRow[];
  numbers: ReadonlyMap<RowId, number>;
  /** the stored rows form a dependency cycle (the server prevents this; shown as an error) */
  cycle: boolean;
}

/**
 * Everything the list and chart draw, from the confirmed rows and the team calendar — or, when
 * switched to a baseline, from the baseline's saved dates.
 */
export function boardModel(
  state: ProjectState,
  calendar: Calendar,
  baseline: { mode: CompareMode; tasks: readonly BaselineTaskDto[] } | null,
): BoardModel {
  const { visible, numbers } = outline(state);
  let schedule: ReturnType<typeof computeSchedule> | null = null;
  try {
    schedule = computeSchedule(state, calendar);
  } catch (error) {
    if (!(error instanceof CycleError)) throw error;
  }
  const saved = new Map<RowId, Ghost>();
  for (const task of baseline?.tasks ?? []) saved.set(task.rowId, { kind: task.kind, span: { start: toDay(task.start), end: toDay(task.end) } });
  const switched = baseline?.mode === "switch";
  const sectionSpans = switched ? rollUpSections(state, saved) : null;

  const rows = visible.map((entry): BoardRow => {
    const { row } = entry;
    const liveKind: DrawKind = row.kind === "section" ? "section" : entry.isParent ? "parent" : row.duration === 0 ? "milestone" : "task";
    const computed = schedule?.get(row.id);
    if (switched) {
      const ghost = saved.get(row.id);
      const span = row.kind === "section" ? (sectionSpans!.get(row.id) ?? null) : (ghost?.span ?? null);
      return { ...entry, span, kind: ghost?.kind ?? liveKind, violation: false, ghost: null };
    }
    return { ...entry, span: computed?.span ?? null, kind: liveKind, violation: computed?.violation ?? false, ghost: saved.get(row.id) ?? null };
  });
  return { rows, numbers, cycle: schedule === null };
}

/** A section's span in a baseline: from the earliest to the latest saved task inside it. */
function rollUpSections(state: ProjectState, saved: ReadonlyMap<RowId, Ghost>): Map<RowId, Span> {
  const spans = new Map<RowId, Span>();
  const limit = Object.keys(state.rows).length;
  for (const [rowId, { span }] of saved) {
    let parentId = state.rows[rowId]?.parentId ?? null;
    for (let steps = limit; parentId !== null && steps > 0; steps--) {
      const parent = state.rows[parentId];
      if (!parent) break;
      if (parent.kind === "section") {
        const current = spans.get(parentId);
        spans.set(parentId, current ? { start: Math.min(current.start, span.start), end: Math.max(current.end, span.end) } : span);
      }
      parentId = parent.parentId;
    }
  }
  return spans;
}
