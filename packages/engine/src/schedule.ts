import type { Calendar, ResourceId } from "./calendar";
import { toDay, type DayNum } from "./date";
import type { ProjectState, Row, RowId, TaskRow } from "./model";
import { buildTree, childrenOf, isParentTask } from "./tree";

export interface Span {
  start: DayNum;
  end: DayNum;
}

export interface Computed {
  /** null when the row has no dates (unscheduled task, or container without scheduled tasks) */
  span: Span | null;
  /** true when a locked task starts earlier than its predecessor rules require */
  violation: boolean;
}

export type Schedule = ReadonlyMap<RowId, Computed>;

export class CycleError extends Error {
  constructor(readonly rowId: RowId) {
    super(`Dependency cycle through row ${rowId}`);
  }
}

interface Constraint {
  predecessorId: RowId;
  offset: number;
}

/**
 * Computes every row's dates from stored inputs. Pure: the result depends only on
 * `state` and `calendar`, never on the order in which edits were made.
 */
export function computeSchedule(state: ProjectState, calendar: Calendar): Schedule {
  const tree = buildTree(state);
  const results = new Map<RowId, Computed>();
  const inProgress = new Set<RowId>();

  const compute = (id: RowId): Computed => {
    const done = results.get(id);
    if (done) return done;
    if (inProgress.has(id)) throw new CycleError(id);
    const row = state.rows[id];
    if (!row) throw new RangeError(`Unknown row ${id}`);
    inProgress.add(id);
    const result =
      row.kind === "section" || isParentTask(tree, row)
        ? { span: rollUp(childrenOf(tree, id).map((child) => compute(child.id).span)), violation: false }
        : computeLeaf(row);
    inProgress.delete(id);
    results.set(id, result);
    return result;
  };

  const computeLeaf = (task: TaskRow): Computed => {
    const resource = task.resourceId;
    // Visit predecessors before anything else — even for unscheduled tasks — so that every
    // dependency cycle is detected. Predecessors that no longer exist are ignored.
    const predecessors = constraintsFor(state, task)
      .filter(({ predecessorId }) => state.rows[predecessorId] !== undefined)
      .map(({ predecessorId, offset }) => ({ span: compute(predecessorId).span, offset }));
    if (task.userStart === null) return { span: null, violation: false };

    const required = requiredStart(calendar, resource, predecessors);
    const userStart = toDay(task.userStart);
    const start = calendar.snap(task.locked ? userStart : Math.max(userStart, required), resource);
    const end = task.duration === 0 ? start : calendar.addWorkingDays(start, task.duration - 1, resource);
    return { span: { start, end }, violation: task.locked && start < required };
  };

  for (const id of Object.keys(state.rows)) compute(id);
  return results;
}

/**
 * The earliest start the constraints allow on `resourceId`'s calendar: for each scheduled
 * predecessor, `max(natural + offset, floor)`. -Infinity when no constraint applies.
 */
export function requiredStart(
  calendar: Calendar,
  resourceId: ResourceId | null,
  constraints: readonly { span: Span | null; offset: number }[],
): number {
  let required = -Infinity;
  for (const { span, offset } of constraints) {
    if (!span) continue;
    const natural = calendar.nextAfter(span.end, resourceId);
    const floor = calendar.nextAfter(span.start, resourceId);
    required = Math.max(required, calendar.addWorkingDays(natural, offset, resourceId), floor);
  }
  return required;
}

/** The task's own predecessor plus those of every ancestor task (parents push their children). */
export function constraintsFor(state: ProjectState, task: TaskRow): Constraint[] {
  const constraints: Constraint[] = [];
  for (let row: Row | undefined = task; row; row = row.parentId === null ? undefined : state.rows[row.parentId]) {
    if (row.kind === "task" && row.predecessorId !== null) {
      constraints.push({ predecessorId: row.predecessorId, offset: row.offset });
    }
  }
  return constraints;
}

export function hasCycle(state: ProjectState, calendar: Calendar): boolean {
  try {
    computeSchedule(state, calendar);
    return false;
  } catch (error) {
    if (error instanceof CycleError) return true;
    throw error;
  }
}

function rollUp(spans: (Span | null)[]): Span | null {
  let result: Span | null = null;
  for (const span of spans) {
    if (!span) continue;
    result = result
      ? { start: Math.min(result.start, span.start), end: Math.max(result.end, span.end) }
      : { ...span };
  }
  return result;
}
