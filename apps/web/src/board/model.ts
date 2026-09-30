import {
  buildTree,
  childrenOf,
  computeSchedule,
  CycleError,
  halfDay,
  spanEnd,
  spanOfHalves,
  spanStart,
  toDay,
  type Calendar,
  type ProjectState,
  type RowId,
  type Span,
  type Tree,
} from "@ganttlines/engine";
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
  /** working days it really took (a task's own; parents and sections add up their subtasks'); null when none recorded */
  actualDays: number | null;
  /** single tasks with actual days: the span those days cover from its start, and how they compare with the plan */
  actual: { span: Span; versusPlan: "over" | "under" | "even" } | null;
}

/** Actual days of a row: a task's own, or the sum over the tasks inside it (null when none recorded). */
export function actualDaysOf(state: ProjectState, tree: Tree, id: RowId): number | null {
  const row = state.rows[id];
  if (!row) return null;
  const children = childrenOf(tree, id);
  if (row.kind === "task" && !children.some((child) => child.kind === "task")) return row.actualDuration;
  let sum: number | null = null;
  for (const child of children) {
    const days = actualDaysOf(state, tree, child.id);
    if (days !== null) sum = (sum ?? 0) + days;
  }
  return sum;
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
  /** search text: show matching rows (and their ancestors) only */
  query = "",
  /** rows collapsed in this browser */
  collapsed: ReadonlySet<RowId> = new Set(),
): BoardModel {
  const needle = query.trim().toLocaleLowerCase();
  const { visible, numbers } = outline(state, needle ? (row) => row.title.toLocaleLowerCase().includes(needle) : undefined, collapsed);
  let schedule: ReturnType<typeof computeSchedule> | null = null;
  try {
    schedule = computeSchedule(state, calendar);
  } catch (error) {
    if (!(error instanceof CycleError)) throw error;
  }
  const saved = new Map<RowId, Ghost>();
  for (const task of baseline?.tasks ?? []) {
    // Baselines saved before half-day scheduling have whole days.
    const span = { start: toDay(task.start), end: toDay(task.end), startsAfternoon: task.startsAfternoon ?? false, endsMidday: task.endsMidday ?? false };
    saved.set(task.rowId, { kind: task.kind, span });
  }
  const switched = baseline?.mode === "switch";
  const sectionSpans = switched ? rollUpSections(state, saved) : null;

  const tree = buildTree(state);
  const rows = visible.map((entry): BoardRow => {
    const { row } = entry;
    const actualDays = actualDaysOf(state, tree, row.id);
    const liveKind: DrawKind = row.kind === "section" ? "section" : entry.isParent ? "parent" : row.duration === 0 ? "milestone" : "task";
    const computed = schedule?.get(row.id);
    if (switched) {
      const ghost = saved.get(row.id);
      const span = row.kind === "section" ? (sectionSpans!.get(row.id) ?? null) : (ghost?.span ?? null);
      return { ...entry, span, kind: ghost?.kind ?? liveKind, violation: false, ghost: null, actualDays, actual: null };
    }
    const span = computed?.span ?? null;
    const single = row.kind === "task" && liveKind === "task";
    let actual: BoardRow["actual"] = null;
    if (single && span && row.actualDuration !== null) {
      // The half days it really took, from where it starts.
      const end = calendar.addWorkingHalves(spanStart(span), row.actualDuration * 2 - 1, row.resourceId);
      const versusPlan = row.actualDuration > row.duration ? "over" : row.actualDuration < row.duration ? "under" : "even";
      actual = { span: spanOfHalves(spanStart(span), end), versusPlan };
    }
    return {
      ...entry,
      span,
      kind: liveKind,
      violation: computed?.violation ?? false,
      ghost: saved.get(row.id) ?? null,
      actualDays,
      actual,
    };
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
        spans.set(parentId, current ? spanOfHalves(Math.min(spanStart(current), spanStart(span)), Math.max(spanEnd(current), spanEnd(span))) : span);
      }
      parentId = parent.parentId;
    }
  }
  return spans;
}
