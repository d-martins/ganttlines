import type { Calendar, ResourceId } from "./calendar";
import { dayOf, halfDay, isAfternoon, toDay, type DayNum, type HalfDay } from "./date";
import type { ProjectState, Row, RowId, TaskRow } from "./model";
import { buildTree, childrenOf, isParentTask } from "./tree";

/** A row's dates: the days it starts and ends on, and whether it starts or ends at midday. */
export interface Span {
  start: DayNum;
  end: DayNum;
  /** starts in the afternoon of `start` */
  startsAfternoon: boolean;
  /** ends at midday of `end` (after its morning) */
  endsMidday: boolean;
}

/** The first half day a span covers. */
export const spanStart = (span: Span): HalfDay => halfDay(span.start, span.startsAfternoon);
/** The last half day a span covers. */
export const spanEnd = (span: Span): HalfDay => halfDay(span.end, !span.endsMidday);
/** The span covering half days `start` … `end`. */
export const spanOfHalves = (start: HalfDay, end: HalfDay): Span => ({
  start: dayOf(start),
  end: dayOf(end),
  startsAfternoon: isAfternoon(start),
  endsMidday: !isAfternoon(end),
});

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
    const userStart = halfDay(toDay(task.userStart), task.startsAfternoon);
    const start = calendar.snapHalf(task.locked ? userStart : Math.max(userStart, required), resource);
    const violation = task.locked && start < required;
    // A milestone is a point on its day; successors start the next working day.
    if (task.duration === 0) return { span: spanOfHalves(start, halfDay(dayOf(start), true)), violation };
    // In half days: 2.5 days from a morning take five half days and end at midday of the third.
    return { span: spanOfHalves(start, calendar.addWorkingHalves(start, task.duration * 2 - 1, resource)), violation };
  };

  for (const id of Object.keys(state.rows)) compute(id);
  return results;
}

/** Where a successor of `span` starts with no offset: the working half day after it ends. */
export function naturalStart(calendar: Calendar, span: Span, resourceId: ResourceId | null): HalfDay {
  return calendar.nextHalfAfter(spanEnd(span), resourceId);
}

/**
 * The earliest a successor of `span` may start, however much it overlaps: the working day after the
 * predecessor's start day — or its natural start, when that's sooner (a half-day predecessor).
 */
export function floorStart(calendar: Calendar, span: Span, resourceId: ResourceId | null): HalfDay {
  return Math.min(halfDay(calendar.nextAfter(span.start, resourceId)), naturalStart(calendar, span, resourceId));
}

/**
 * The earliest start (a half day) the constraints allow on `resourceId`'s calendar: for each
 * scheduled predecessor, `max(natural + offset, floor)`. -Infinity when no constraint applies.
 */
export function requiredStart(
  calendar: Calendar,
  resourceId: ResourceId | null,
  constraints: readonly { span: Span | null; offset: number }[],
): HalfDay {
  let required = -Infinity;
  for (const { span, offset } of constraints) {
    if (!span) continue;
    const natural = naturalStart(calendar, span, resourceId);
    required = Math.max(required, calendar.addWorkingHalves(natural, offset * 2, resourceId), floorStart(calendar, span, resourceId));
  }
  return required;
}

/** The task's own predecessor plus those of every ancestor task (parents push their children). */
export function constraintsFor(state: ProjectState, task: TaskRow): Constraint[] {
  const constraints: Constraint[] = [];
  // Bounded by the row count so corrupted parent links can never loop forever.
  let steps = Object.keys(state.rows).length + 1;
  for (let row: Row | undefined = task; row && steps > 0; row = row.parentId === null ? undefined : state.rows[row.parentId], steps--) {
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
    result = result ? spanOfHalves(Math.min(spanStart(result), spanStart(span)), Math.max(spanEnd(result), spanEnd(span))) : { ...span };
  }
  return result;
}
