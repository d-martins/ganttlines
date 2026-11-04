import type { Calendar, ResourceId } from "./calendar";
import { dayOf, type HalfDay } from "./date";
import { isFinishLink, linkKey, type Link, type LinkKey } from "./links";
import type { ProjectState, Row, RowId, TaskRow } from "./model";
import { finishFloor, linkRequirement, spanEnd, spanOfHalves, spanStart, type Schedule, type Span } from "./schedule";
import { buildTree, descendantLeafTasks, isParentTask } from "./tree";

/** What stops a task slipping further: a milestone, a locked task, or the end of the board. */
export type SlackLimit = { kind: "milestone"; id: RowId } | { kind: "task"; id: RowId } | { kind: "end" };
/** How many working half days a task's finish can move later before it hits `limit`; negative: already past it. */
export interface Slack {
  halves: number;
  limit: SlackLimit;
}
export type SlackMap = ReadonlyMap<RowId, Slack>;

/** The task's own target, else its nearest ancestor's. */
export function effectiveTarget(state: ProjectState, row: Row): RowId | null {
  return targetOf(state, row, Object.keys(state.rows).length);
}

function targetOf(state: ProjectState, row: Row, rowCount: number): RowId | null {
  let steps = rowCount + 1;
  for (let up: Row | undefined = row; up && steps > 0; up = up.parentId === null ? undefined : state.rows[up.parentId], steps--) {
    if (up.kind === "task" && (up.targetId ?? null) !== null) return up.targetId;
  }
  return null;
}

/** Working half days on one calendar, counted up front: slack asks for them thousands of times. */
class Clock {
  private readonly counts: Int32Array;
  private readonly working: HalfDay[] = [];

  constructor(
    private readonly calendar: Calendar,
    private readonly resource: ResourceId | null,
    private readonly from: HalfDay,
    to: HalfDay,
  ) {
    this.counts = new Int32Array(to - from + 1);
    for (let half = from; half <= to; half++) {
      if (calendar.isWorkingDay(dayOf(half), resource)) this.working.push(half);
      this.counts[half - from] = this.working.length;
    }
  }

  private covers(half: HalfDay): boolean {
    return half - 1 >= this.from && half - this.from < this.counts.length;
  }

  private countTo(half: HalfDay): number {
    return this.counts[half - this.from]!;
  }

  /** As `Calendar.workingHalvesBetween`. */
  between(from: HalfDay, to: HalfDay): number {
    if (!this.covers(from) || !this.covers(to)) return this.calendar.workingHalvesBetween(from, to, this.resource);
    return to >= from ? this.countTo(to) - this.countTo(from) : this.countTo(to - 1) - this.countTo(from - 1);
  }

  /** As `Calendar.addWorkingHalves`, from a working half day. */
  add(half: HalfDay, n: number): HalfDay {
    if (this.covers(half) && this.calendar.isWorkingDay(dayOf(half), this.resource)) {
      const moved = this.working[this.countTo(half) - 1 + n];
      if (moved !== undefined) return moved;
    }
    return this.calendar.addWorkingHalves(this.calendar.snapHalf(half, this.resource), n, this.resource);
  }
}

const RANK: Record<SlackLimit["kind"], number> = { milestone: 0, task: 1, end: 2 };
const tighter = (a: Slack, b: Slack) => a.halves < b.halves || (a.halves === b.halves && RANK[a.limit.kind] < RANK[b.limit.kind]);
/** Milestones move in whole days. */
const wholeDays = (halves: number) => Math.floor(halves / 2) * 2;

export interface SlackAnalysis {
  slack: SlackMap;
  /** the links with no room, so a slip passes straight through them */
  critical: ReadonlySet<LinkKey>;
  /** tasks past their own target, directly or by inheritance, and the parents of those */
  pastTarget: ReadonlySet<RowId>;
}

/** The earliest and latest subtask edges under a parent, with the runners-up for when the first moves. */
interface Edges {
  firstStart: { id: RowId; half: HalfDay };
  nextStart: HalfDay;
  lastEnd: { id: RowId; half: HalfDay };
  nextEnd: HalfDay;
}

/** How far each scheduled task can slip, and what limits it; parents show their subtasks' tightest. */
export function analyseSlack(state: ProjectState, calendar: Calendar, schedule: Schedule): SlackAnalysis {
  const tree = buildTree(state);
  const task = (id: RowId): TaskRow | null => {
    const row = state.rows[id];
    return row?.kind === "task" ? row : null;
  };
  const spanOf = (id: RowId): Span | null => schedule.get(id)?.span ?? null;

  const scheduled = Object.values(state.rows).filter((row): row is TaskRow => row.kind === "task" && spanOf(row.id) !== null);
  const spans = scheduled.map((row) => spanOf(row.id)!);
  const slack = new Map<RowId, Slack>();
  const linkRoom = new Map<LinkKey, number>();
  const pastTarget = new Set<RowId>();
  if (spans.length === 0) return { slack, critical: new Set(), pastTarget };

  const earliest = Math.min(...spans.map(spanStart));
  const boardEnd = Math.max(...spans.map(spanEnd));
  const reach = Math.max(boardEnd - earliest, 8);
  const clocks = new Map<ResourceId | null, Clock>();
  const clockOf = (resource: ResourceId | null): Clock => {
    let clock = clocks.get(resource);
    if (!clock) clocks.set(resource, (clock = new Clock(calendar, resource, earliest - reach - 400, boardEnd + reach + 400)));
    return clock;
  };

  const rowCount = Object.keys(state.rows).length;
  const out = new Map<RowId, Link[]>();
  for (const link of Object.values(state.links)) out.set(link.predecessorId, [...(out.get(link.predecessorId) ?? []), link]);
  const ancestorsOf = (row: Row): TaskRow[] => {
    const ancestors: TaskRow[] = [];
    let steps = rowCount + 1;
    for (let up = row.parentId === null ? undefined : state.rows[row.parentId]; up && steps > 0; up = up.parentId === null ? undefined : state.rows[up.parentId], steps--) {
      if (up.kind === "task") ancestors.push(up);
    }
    return ancestors;
  };
  const isLeaf = (row: TaskRow) => !isParentTask(tree, row);

  const edges = new Map<RowId, Edges>();
  for (const leaf of scheduled.filter(isLeaf)) {
    const span = spanOf(leaf.id)!;
    for (const ancestor of ancestorsOf(leaf)) {
      const seen = edges.get(ancestor.id) ?? { firstStart: { id: "", half: Infinity }, nextStart: Infinity, lastEnd: { id: "", half: -Infinity }, nextEnd: -Infinity };
      if (spanStart(span) < seen.firstStart.half) {
        seen.nextStart = seen.firstStart.half;
        seen.firstStart = { id: leaf.id, half: spanStart(span) };
      } else seen.nextStart = Math.min(seen.nextStart, spanStart(span));
      if (spanEnd(span) > seen.lastEnd.half) {
        seen.nextEnd = seen.lastEnd.half;
        seen.lastEnd = { id: leaf.id, half: spanEnd(span) };
      } else seen.nextEnd = Math.max(seen.nextEnd, spanEnd(span));
      edges.set(ancestor.id, seen);
    }
  }

  /** The leaves a start link into `follower` holds back, or the parent an end link stretches. */
  const heldBy = (link: Link): { leaves: TaskRow[]; stretched: TaskRow | null } => {
    const follower = task(link.followerId);
    if (!follower || !spanOf(follower.id)) return { leaves: [], stretched: null };
    if (isLeaf(follower)) return { leaves: [follower], stretched: null };
    if (isFinishLink(link.kind)) return { leaves: [], stretched: follower };
    return { leaves: descendantLeafTasks(tree, follower.id).filter((leaf) => spanOf(leaf.id)), stretched: null };
  };

  const linksLeaving = (row: TaskRow): Link[] => [row, ...ancestorsOf(row)].flatMap((up) => out.get(up.id) ?? []);
  const dependencies = (row: TaskRow): RowId[] =>
    linksLeaving(row).flatMap((link) => {
      const { leaves, stretched } = heldBy(link);
      return [...leaves.map((leaf) => leaf.id), ...(stretched ? [stretched.id] : [])];
    });

  /** For a leaf, or a parent's own end (only ever asked for what stretches it). */
  const measure = (row: TaskRow): Slack => {
    const span = spanOf(row.id)!;
    const clock = clockOf(isLeaf(row) ? row.resourceId : null);
    const milestone = isLeaf(row) && row.duration === 0;
    const movesWhole = isLeaf(row);
    const moved = (k: number): Span => {
      const by = milestone ? wholeDays(k) : k;
      return spanOfHalves(movesWhole ? clock.add(spanStart(span), by) : spanStart(span), clock.add(spanEnd(span), by));
    };
    /** The span of `up` (this row or an ancestor) with this row `k` halves later. */
    const spanOfPredecessor = (up: RowId, k: number): Span => {
      const shifted = moved(k);
      if (up === row.id) return shifted;
      const parent = spanOf(up)!;
      const seen = edges.get(up);
      if (!seen) return parent;
      const others = {
        start: seen.firstStart.id === row.id ? seen.nextStart : seen.firstStart.half,
        // An end link can stretch a parent past all its subtasks.
        end: Math.max(seen.lastEnd.id === row.id ? seen.nextEnd : seen.lastEnd.half, spanEnd(parent) > seen.lastEnd.half ? spanEnd(parent) : -Infinity),
      };
      return spanOfHalves(Math.min(others.start, spanStart(shifted)), Math.max(others.end, spanEnd(shifted)));
    };

    let best: Slack = { halves: clock.between(spanEnd(span), boardEnd), limit: { kind: "end" } };
    const offer = (candidate: Slack) => {
      if (tighter(candidate, best)) best = candidate;
    };

    // A milestone has nothing to aim with, so it doesn't pick up a parent's target either.
    const target = milestone ? null : targetOf(state, row, rowCount);
    const targetSpan = target !== null && target !== row.id ? spanOf(target) : null;
    if (target !== null && targetSpan) {
      const gap = clock.between(spanEnd(span), spanEnd(targetSpan));
      if (gap < 0 && isLeaf(row)) for (const up of [row, ...ancestorsOf(row)]) pastTarget.add(up.id);
      offer({ halves: gap, limit: { kind: "milestone", id: target } });
    }

    for (const link of linksLeaving(row)) {
      const { leaves, stretched } = heldBy(link);
      const checks: { allows: (predecessor: Span) => boolean; limit: SlackLimit }[] = leaves.map((follower) => {
        const followerSlack = slack.get(follower.id);
        const latest = follower.locked || !followerSlack ? spanStart(spanOf(follower.id)!) : clockOf(follower.resourceId).add(spanStart(spanOf(follower.id)!), followerSlack.halves);
        const limit: SlackLimit = follower.locked || !followerSlack ? { kind: "task", id: follower.id } : followerSlack.limit;
        return { allows: (predecessor) => linkRequirement(calendar, follower, link, predecessor) <= latest, limit };
      });
      if (stretched) {
        const own = slack.get(stretched.id);
        const latest = clockOf(null).add(spanEnd(spanOf(stretched.id)!), own?.halves ?? 0);
        checks.push({ allows: (predecessor) => finishFloor(calendar, link, predecessor, null) <= latest, limit: own?.limit ?? { kind: "end" } });
      }
      for (const { allows, limit } of checks) {
        const own = link.predecessorId === row.id;
        // A miss can be bigger than the board is long.
        let found = largestFit((k) => allows(spanOfPredecessor(link.predecessorId, k)), reach, own ? reach * 64 : reach);
        // Other subtasks hold the parent's edge past what the link allows: nothing this row does fixes
        // that, so all it answers for is not making it worse with its own span.
        if (found === -Infinity && !own) found = largestFit((k) => allows(moved(k)), reach, reach * 64);
        if (found === Infinity) continue;
        const low = found === -Infinity ? -reach * 64 : found;
        const room = milestone ? wholeDays(low) : low;
        if (isLeaf(row)) linkRoom.set(linkKey(link), Math.min(linkRoom.get(linkKey(link)) ?? Infinity, room));
        offer({ halves: room, limit });
      }
    }
    return milestone ? { ...best, halves: wholeDays(best.halves) } : best;
  };

  // Followers first, with an explicit stack so that long chains can't overflow the call stack.
  const stretchedOnly = new Set<RowId>();
  const done = new Set<RowId>();
  const entered = new Set<RowId>();
  for (const first of scheduled.filter(isLeaf)) {
    const stack: RowId[] = [first.id];
    while (stack.length > 0) {
      const id = stack[stack.length - 1]!;
      if (done.has(id)) {
        stack.pop();
        continue;
      }
      const row = task(id)!;
      if (!entered.has(id)) {
        entered.add(id);
        const waiting = dependencies(row).filter((other) => !done.has(other) && !entered.has(other));
        if (waiting.length > 0) {
          stack.push(...waiting);
          continue;
        }
      }
      slack.set(id, measure(row));
      if (!isLeaf(row)) stretchedOnly.add(id);
      done.add(id);
      stack.pop();
    }
  }

  // What shows for a parent is its subtasks' tightest, not the parent's own end measured above.
  for (const id of stretchedOnly) slack.delete(id);
  // A number needs something behind it: a task connected to nothing would only be measured against
  // whatever happens to be last on the board.
  const linked = new Set(Object.values(state.links).flatMap((link) => [link.predecessorId, link.followerId]));
  const aimedAt = new Set(scheduled.flatMap((row) => (row.targetId ? [row.targetId] : [])));
  for (const leaf of scheduled.filter(isLeaf)) {
    const milestone = leaf.duration === 0;
    const connected = aimedAt.has(leaf.id) || (!milestone && targetOf(state, leaf, rowCount) !== null) || [leaf, ...ancestorsOf(leaf)].some((row) => linked.has(row.id));
    if (!connected) slack.delete(leaf.id);
  }
  for (const parent of scheduled.filter((row) => !isLeaf(row))) {
    let tightest: Slack | null = null;
    for (const leaf of descendantLeafTasks(tree, parent.id)) {
      const measured = slack.get(leaf.id);
      if (measured && (!tightest || tighter(measured, tightest))) tightest = measured;
    }
    if (tightest) slack.set(parent.id, tightest);
  }
  return { slack, critical: new Set([...linkRoom].filter(([, room]) => room <= 0).map(([key]) => key)), pastTarget };
}

/**
 * The largest shift that `fits`, which only gets harder as the shift grows, searching out from 0 as most
 * answers are small. Infinity: it still fits at `up`; -Infinity: it doesn't even at `-down`.
 */
function largestFit(fits: (k: number) => boolean, up: number, down: number): number {
  let low: number;
  let high: number;
  if (fits(0)) {
    low = 0;
    for (let step = 1; ; step *= 2) {
      high = low + step;
      if (high > up) {
        if (fits(up)) return Infinity;
        high = up;
        break;
      }
      if (!fits(high)) break;
      low = high;
    }
  } else {
    high = 0;
    for (let step = 1; ; step *= 2) {
      low = high - step;
      if (low < -down) {
        if (!fits(-down)) return -Infinity;
        low = -down;
        break;
      }
      if (fits(low)) break;
      high = low;
    }
  }
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle;
  }
  return low;
}

/** Just the numbers from `analyseSlack`. */
export function computeSlack(state: ProjectState, calendar: Calendar, schedule: Schedule): SlackMap {
  return analyseSlack(state, calendar, schedule).slack;
}
