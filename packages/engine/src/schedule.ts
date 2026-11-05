import type { Calendar, ResourceId } from "./calendar";
import { dayOf, halfDay, isAfternoon, toDay, type DayNum, type HalfDay } from "./date";
import { isFinishLink, linkKey, type Link, type LinkKey } from "./links";
import type { ProjectState, Row, RowId, TaskRow } from "./model";
import { layOutWork, partsOf } from "./parts";
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
  /** the stretches it's worked, only when more than one; `span` runs from the first to the last */
  parts?: readonly Span[];
}

export type Schedule = ReadonlyMap<RowId, Computed>;

export class CycleError extends Error {
  constructor(readonly rowId: RowId) {
    super(`Dependency cycle through row ${rowId}`);
  }
}

export type FollowerIndex = ReadonlyMap<RowId, readonly Link[]>;

/** Every task's incoming links, each list ordered by key. */
export function indexByFollower(state: ProjectState): FollowerIndex {
  const keyed = Object.values(state.links ?? {})
    .map((link) => [linkKey(link), link] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const index = new Map<RowId, Link[]>();
  for (const [, link] of keyed) {
    const links = index.get(link.followerId);
    if (links) links.push(link);
    else index.set(link.followerId, [link]);
  }
  return index;
}

/**
 * Computes every row's dates from stored inputs. Pure: the result depends only on
 * `state` and `calendar`, never on the order in which edits were made.
 */
export function computeSchedule(state: ProjectState, calendar: Calendar): Schedule {
  const tree = buildTree(state);
  const into = indexByFollower(state);
  const results = new Map<RowId, Computed>();
  const inProgress = new Set<RowId>();
  const rowCount = Object.keys(state.rows).length;
  // Links whose predecessor no longer exists are ignored.
  const existing = (links: readonly Link[]) => links.filter(({ predecessorId }) => state.rows[predecessorId] !== undefined);

  const compute = (id: RowId): Computed => {
    const done = results.get(id);
    if (done) return done;
    if (inProgress.has(id)) throw new CycleError(id);
    const row = state.rows[id];
    if (!row) throw new RangeError(`Unknown row ${id}`);
    inProgress.add(id);
    const result = row.kind === "section" || isParentTask(tree, row) ? computeContainer(row) : computeLeaf(row);
    inProgress.delete(id);
    results.set(id, result);
    return result;
  };

  const computeContainer = (row: Row): Computed => {
    let span = rollUp(childrenOf(tree, row.id).map((child) => compute(child.id).span));
    if (row.kind !== "task") return { span, violation: false };
    // An FF or SF link into a parent stretches its end; its subtasks keep their dates.
    for (const link of existing(into.get(row.id) ?? [])) {
      if (!isFinishLink(link.kind)) continue;
      const predecessor = compute(link.predecessorId).span;
      if (!span || !predecessor) continue;
      const end = finishFloor(calendar, link, predecessor, null);
      if (end > spanEnd(span)) span = spanOfHalves(spanStart(span), end);
    }
    return { span, violation: false };
  };

  const computeLeaf = (task: TaskRow): Computed => {
    const resource = task.resourceId;
    // Visit predecessors before anything else — even for unscheduled tasks — so that every
    // dependency cycle is detected.
    const constraints = existing(collectConstraints(state, task, true, into, rowCount)).map((link) => ({ link, span: compute(link.predecessorId).span }));
    const interrupters = task.locked ? [] : (task.interruptedBy ?? []).filter((id) => state.rows[id] !== undefined).map((id) => compute(id));
    if (task.userStart === null) return { span: null, violation: false };

    const required = requiredStart(calendar, task, constraints);
    const userStart = halfDay(toDay(task.userStart), task.startsAfternoon);
    const start = calendar.snapHalf(task.locked ? userStart : Math.max(userStart, required), resource);
    const violation = task.locked && start < required;
    // A milestone is a point on its day; successors start the next working day.
    if (task.duration === 0) return { span: spanOfHalves(start, halfDay(dayOf(start), true)), violation };
    const breaks = task.breaks ?? [];
    if (breaks.length > 0 || interrupters.length > 0) {
      const parts = layOutWork(calendar, start, task.duration * 2, breaks, interrupters.flatMap(partsOf), resource);
      const span = spanOfHalves(spanStart(parts[0]!), spanEnd(parts.at(-1)!));
      return parts.length > 1 ? { span, violation, parts } : { span, violation };
    }
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
 * The earliest last half day an FF or SF follower of `span` may end on, plus the link's lag: FF, the
 * predecessor's last half; SF, the working half just before its first half.
 */
export function finishFloor(calendar: Calendar, link: Link, span: Span, resourceId: ResourceId | null): HalfDay {
  const edge = link.kind === "SF" ? calendar.snapHalfBack(spanStart(span) - 1, resourceId) : calendar.snapHalf(spanEnd(span), resourceId);
  return calendar.addWorkingHalves(edge, link.lag * 2, resourceId);
}

/** The earliest start (half day) `link` allows `follower`, given the predecessor's span; -Infinity if unscheduled. */
export function linkRequirement(
  calendar: Calendar,
  follower: Pick<TaskRow, "resourceId" | "duration"> & Partial<Pick<TaskRow, "breaks">>,
  link: Link,
  predecessor: Span | null,
): HalfDay {
  if (!predecessor) return -Infinity;
  const resource = follower.resourceId;
  switch (link.kind) {
    case "FS": {
      const natural = naturalStart(calendar, predecessor, resource);
      return Math.max(calendar.addWorkingHalves(natural, link.lag * 2, resource), floorStart(calendar, predecessor, resource));
    }
    case "SS":
      return calendar.addWorkingHalves(calendar.snapHalf(spanStart(predecessor), resource), link.lag * 2, resource);
    case "FF":
    case "SF": {
      const end = finishFloor(calendar, link, predecessor, resource);
      // A milestone sits on the day it may end; other tasks start early enough to end on it.
      if (follower.duration === 0) return halfDay(dayOf(end));
      const paused = (follower.breaks ?? []).reduce((sum, pause) => sum + pause.length, 0);
      return calendar.addWorkingHalves(end, -(follower.duration * 2 - 1 + paused), resource);
    }
  }
}

/** The lowest start a drag may reach against `link` (lag at its floor). */
export function linkFloor(calendar: Calendar, follower: Pick<TaskRow, "resourceId" | "duration"> & Partial<Pick<TaskRow, "breaks">>, link: Link, predecessor: Span): HalfDay {
  if (link.kind === "FS") return floorStart(calendar, predecessor, follower.resourceId);
  return linkRequirement(calendar, follower, { ...link, lag: 0 }, predecessor);
}

/** The earliest start (a half day) the constraints allow `follower`: the strictest link wins. -Infinity when none applies. */
export function requiredStart(
  calendar: Calendar,
  follower: Pick<TaskRow, "resourceId" | "duration"> & Partial<Pick<TaskRow, "breaks">>,
  constraints: readonly { link: Link; span: Span | null }[],
): HalfDay {
  let required = -Infinity;
  for (const { link, span } of constraints) required = Math.max(required, linkRequirement(calendar, follower, link, span));
  return required;
}

/**
 * A leaf's own links plus its ancestors' FS and SS links (FF and SF onto a parent stretch it instead);
 * `own: false` leaves out the task's own links. Pass `into` (from `indexByFollower(state)`) when
 * asking for many tasks of one state.
 */
export function constraintsFor(state: ProjectState, task: TaskRow, own = true, into: FollowerIndex = indexByFollower(state)): Link[] {
  return collectConstraints(state, task, own, into);
}

function collectConstraints(state: ProjectState, task: TaskRow, own: boolean, into: FollowerIndex, rowCount = Object.keys(state.rows).length): Link[] {
  const constraints: Link[] = [];
  // Bounded by the row count so corrupted parent links can never loop forever.
  let steps = rowCount + 1;
  for (let row: Row | undefined = task; row && steps > 0; row = row.parentId === null ? undefined : state.rows[row.parentId], steps--) {
    if (row.kind !== "task" || (!own && row === task)) continue;
    for (const link of into.get(row.id) ?? []) {
      if (row === task || !isFinishLink(link.kind)) constraints.push(link);
    }
  }
  return constraints;
}

/** Keys of links a locked follower starts too early for. */
export function violatedLinks(state: ProjectState, calendar: Calendar, schedule: Schedule): Set<LinkKey> {
  const tree = buildTree(state);
  const into = indexByFollower(state);
  const violated = new Set<LinkKey>();
  for (const row of Object.values(state.rows)) {
    if (row.kind !== "task" || !row.locked || isParentTask(tree, row)) continue;
    const span = schedule.get(row.id)?.span;
    if (!span) continue;
    for (const link of collectConstraints(state, row, true, into)) {
      if (spanStart(span) < linkRequirement(calendar, row, link, schedule.get(link.predecessorId)?.span ?? null)) violated.add(linkKey(link));
    }
  }
  return violated;
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
