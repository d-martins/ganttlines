import { generateKeyBetween } from "fractional-indexing";
import type { Calendar, ResourceId } from "./calendar";
import { diffState, type Change } from "./changes";
import { dayOf, fromDay, halfDay, isAfternoon, toDay, type DayNum, type HalfDay, type IsoDate } from "./date";
import { linkKey, linksInto, MAX_LAG, type Link, type LinkKey } from "./links";
import { TASK_COLORS, TASK_DEFAULTS, type ProjectState, type Row, type RowId, type TaskColor, type TaskRow } from "./model";
import { computeSchedule, constraintsFor, CycleError, hasCycle, floorStart, naturalStart, requiredStart, spanEnd, spanStart, type Schedule, type Span } from "./schedule";
import { buildTree, childrenOf, descendantLeafTasks, isAncestor, isParentTask, subtreeIds, type Tree } from "./tree";

export type DayHalf = "morning" | "afternoon";

export type Command =
  | { type: "createRow"; id: RowId; kind: "task" | "section"; parentId: RowId | null; afterId: RowId | null; title: string; start?: IsoDate }
  | { type: "updateTitle"; id: RowId; title: string }
  | { type: "setDescription"; id: RowId; description: string }
  | { type: "setColor"; id: RowId; color: TaskColor }
  | { type: "setAssignee"; id: RowId; resourceId: ResourceId | null }
  /** `half`: the half of `start` the task starts in (default the morning). */
  | { type: "moveTask"; id: RowId; start: IsoDate; half?: DayHalf }
  /** `half`: the half of `date` the edge is in (default: the morning for the start, the afternoon for the end). */
  | { type: "resizeTask"; id: RowId; edge: "start" | "end"; date: IsoDate; half?: DayHalf }
  | { type: "setDuration"; id: RowId; duration: number }
  | { type: "setActualDuration"; id: RowId; days: number | null }
  | { type: "convertMilestone"; id: RowId; milestone: boolean }
  | { type: "setLocked"; id: RowId; locked: boolean }
  | { type: "linkTasks"; fromId: RowId; toId: RowId }
  | { type: "removePredecessor"; id: RowId }
  | { type: "setOffset"; id: RowId; offset: number }
  | { type: "indent"; id: RowId }
  | { type: "outdent"; id: RowId }
  | { type: "moveRow"; id: RowId; parentId: RowId | null; afterId: RowId | null }
  | { type: "deleteRows"; ids: RowId[] }
  | { type: "duplicateTask"; id: RowId; newId: RowId };

/** Input limits: keep every calendar walk bounded, so no command can hang the server. */
export const MAX_DURATION = 3660;
export const MIN_DATE: IsoDate = "1970-01-01";
export const MAX_DATE: IsoDate = "2199-12-31";

export type RejectReason = "not_found" | "invalid" | "locked" | "cycle" | "unscheduled";

export type CommandResult =
  | { ok: true; state: ProjectState; changes: Change[] }
  | { ok: false; reason: RejectReason; message: string };

class Rejection extends Error {
  constructor(
    readonly reason: RejectReason,
    message: string,
  ) {
    super(message);
  }
}

/** Applies one command. Deterministic: same state + calendar + command → same result. */
export function applyCommand(state: ProjectState, calendar: Calendar, command: Command): CommandResult {
  try {
    const next = new Execution(state, calendar).run(command);
    if (hasCycle(next, calendar)) return { ok: false, reason: "cycle", message: "That would create a dependency cycle" };
    return { ok: true, state: next, changes: diffState(state, next) };
  } catch (error) {
    if (error instanceof Rejection) return { ok: false, reason: error.reason, message: error.message };
    if (error instanceof CycleError) return { ok: false, reason: "cycle", message: error.message };
    if (error instanceof RangeError) return { ok: false, reason: "invalid", message: error.message };
    throw error;
  }
}

class Execution {
  private readonly rows: Record<RowId, Row>;
  private readonly links: Record<LinkKey, Link>;
  private readonly tree: Tree;
  private cachedSchedule: Schedule | undefined;

  constructor(
    private readonly state: ProjectState,
    private readonly calendar: Calendar,
  ) {
    this.rows = { ...state.rows };
    this.links = { ...state.links };
    this.tree = buildTree(state);
  }

  run(command: Command): ProjectState {
    this.apply(command);
    this.settleFormerParents();
    return this.result();
  }

  private apply(command: Command): ProjectState {
    switch (command.type) {
      case "createRow":
        return this.createRow(command);
      case "updateTitle":
        return this.patch(this.row(command.id), { title: command.title });
      case "setDescription":
        return this.patch(this.task(command.id), { description: command.description });
      case "setColor":
        if (!TASK_COLORS.includes(command.color)) throw new Rejection("invalid", `Unknown color ${command.color}`);
        return this.patch(this.task(command.id), { color: command.color });
      case "setAssignee":
        return this.patch(this.task(command.id), { resourceId: command.resourceId });
      case "moveTask":
        return this.moveTask(command.id, halfDay(this.day(command.start), command.half === "afternoon"));
      case "resizeTask":
        return this.resizeTask(command.id, command.edge, halfDay(this.day(command.date), (command.half ?? (command.edge === "end" ? "afternoon" : "morning")) === "afternoon"));
      case "setDuration":
        return this.setDuration(command.id, command.duration);
      case "setActualDuration":
        return this.setActualDuration(command.id, command.days);
      case "convertMilestone":
        return this.convertMilestone(command.id, command.milestone);
      case "setLocked":
        return this.setLocked(command.id, command.locked);
      case "linkTasks":
        return this.linkTasks(command.fromId, command.toId);
      case "removePredecessor":
        return this.removePredecessor(command.id);
      case "setOffset":
        return this.setOffset(command.id, command.offset);
      case "indent":
        return this.indent(command.id);
      case "outdent":
        return this.outdent(command.id);
      case "moveRow":
        return this.moveRow(command.id, command.parentId, command.afterId);
      case "deleteRows":
        return this.deleteRows(command.ids);
      case "duplicateTask":
        return this.duplicateTask(command.id, command.newId);
    }
  }

  // ── rows ────────────────────────────────────────────────────────────────

  private createRow(command: Extract<Command, { type: "createRow" }>): ProjectState {
    if (command.id === "") throw new Rejection("invalid", "Row ids cannot be empty");
    if (this.rows[command.id]) throw new Rejection("invalid", `Row ${command.id} already exists`);
    this.assertValidParent(command.kind, command.parentId);
    const position = this.positionAfter(command.parentId, command.afterId);
    const base = { id: command.id, title: command.title, parentId: command.parentId, position };
    if (command.kind === "section") {
      if (command.start !== undefined) throw new Rejection("invalid", "Sections have no dates");
      this.rows[command.id] = { ...base, kind: "section" };
    } else {
      const userStart = command.start === undefined ? null : fromDay(this.calendar.snap(this.day(command.start), null));
      this.rows[command.id] = { ...TASK_DEFAULTS, ...base, kind: "task", userStart };
    }
    return this.result();
  }

  private indent(id: RowId): ProjectState {
    const row = this.row(id);
    const siblings = childrenOf(this.tree, row.parentId);
    const previous = siblings[siblings.findIndex((sibling) => sibling.id === id) - 1];
    if (!previous) throw new Rejection("invalid", "Nothing to indent under");
    this.assertValidParent(row.kind, previous.id);
    return this.patch(row, { parentId: previous.id, position: this.positionAfter(previous.id, this.lastChildId(previous.id)) });
  }

  private outdent(id: RowId): ProjectState {
    const row = this.row(id);
    if (row.parentId === null) throw new Rejection("invalid", "Already at the top level");
    const parent = this.row(row.parentId);
    return this.patch(row, { parentId: parent.parentId, position: this.positionAfter(parent.parentId, parent.id) });
  }

  private moveRow(id: RowId, parentId: RowId | null, afterId: RowId | null): ProjectState {
    const row = this.row(id);
    if (parentId === id || (parentId !== null && isAncestor(this.state, id, parentId))) {
      throw new Rejection("invalid", "A row cannot be moved inside itself");
    }
    this.assertValidParent(row.kind, parentId);
    return this.patch(row, { parentId, position: this.positionAfter(parentId, afterId, id) });
  }

  private deleteRows(ids: RowId[]): ProjectState {
    const removed = new Set<RowId>();
    // Ids that no longer exist are ignored: live sessions may send stale selections.
    for (const id of ids) if (this.rows[id]) for (const subId of subtreeIds(this.tree, id)) removed.add(subId);
    for (const id of removed) delete this.rows[id];
    for (const [key, link] of Object.entries(this.links)) {
      if (removed.has(link.followerId) || (removed.has(link.predecessorId) && link.kind !== "FS")) delete this.links[key];
    }
    for (const row of Object.values(this.rows)) {
      if (row.kind !== "task") continue;
      const detached = this.fsLinksInto(row.id).filter((link) => removed.has(link.predecessorId));
      if (detached.length > 0) this.detachPredecessor(row, detached);
    }
    return this.result();
  }

  private duplicateTask(id: RowId, newId: RowId): ProjectState {
    const original = this.task(id);
    if (isParentTask(this.tree, original)) throw new Rejection("invalid", "Only single tasks can be duplicated");
    if (this.rows[newId]) throw new Rejection("invalid", `Row ${newId} already exists`);
    // A copy is new work: it hasn't taken any actual days yet.
    this.rows[newId] = { ...original, id: newId, actualDuration: null, position: this.positionAfter(original.parentId, original.id) };
    // The copy follows what the original follows.
    for (const link of linksInto(this.result(), id)) this.putLink({ ...link, followerId: newId });
    return this.result();
  }

  // ── dates ───────────────────────────────────────────────────────────────

  private moveTask(id: RowId, target: HalfDay): ProjectState {
    const task = this.task(id);
    if (!isParentTask(this.tree, task)) return this.patch(this.editableLeaf(id), this.placeLeaf(task, target));

    const span = this.spanOf(id);
    if (!span) throw new Rejection("unscheduled", "This parent task has no scheduled subtasks");
    const moving = this.movingIds(id);
    const leaves = descendantLeafTasks(this.tree, id).filter((leaf) => moving.has(leaf.id));
    if (leaves.length === 0) throw new Rejection("locked", "All subtasks are locked");
    // Measured from the moving subtasks, so locked subtasks never shift the others.
    const from = Math.min(...leaves.map((leaf) => spanStart(this.spanOf(leaf.id)!)));
    let half = this.calendar.addWorkingHalves(from, this.calendar.workingHalvesBetween(spanStart(span), this.calendar.snapHalf(target, null), null), null);
    // The parent's own predecessors follow the leaf rule, measured on the unassigned calendar.
    half = this.anchor(task, half, null);
    const delta = this.calendar.workingHalvesBetween(from, half, null);
    const shifted = new Map<RowId, HalfDay>();
    for (const leaf of leaves) {
      shifted.set(leaf.id, this.calendar.addWorkingHalves(spanStart(this.spanOf(leaf.id)!), delta, leaf.resourceId));
      this.patch(leaf, startAt(shifted.get(leaf.id)!));
    }
    // Re-anchor leaves tied to tasks outside the group against where those tasks now are
    // (outside tasks may themselves follow the group).
    // A single pass by design: groups attached through outside tasks move rigidly, but an
    // outside successor chained to the group is not iterated to a fixpoint (its offset may
    // then differ slightly; stored starts still match the schedule via the final pass).
    const shiftedSchedule = computeSchedule(this.result(), this.calendar);
    const spanIn = (taskId: RowId) => shiftedSchedule.get(taskId)?.span ?? null;
    for (const leaf of leaves) {
      const current = this.rows[leaf.id] as TaskRow;
      const outside = constraintsFor(this.result(), current).some(({ predecessorId }) => !moving.has(predecessorId));
      if (outside) this.patch(current, this.placeLeaf(current, shifted.get(leaf.id)!, moving, spanIn));
    }
    // Store exactly what the schedule will show, so the drag is never silently undone.
    const schedule = computeSchedule(this.result(), this.calendar);
    for (const leaf of leaves) {
      const leafSpan = schedule.get(leaf.id)?.span;
      if (leafSpan) this.patch(this.rows[leaf.id] as TaskRow, startAt(spanStart(leafSpan)));
    }
    return this.result();
  }

  private resizeTask(id: RowId, edge: "start" | "end", at: HalfDay): ProjectState {
    const task = this.editableLeaf(id);
    if (task.duration === 0) throw new Rejection("invalid", "Milestones cannot be resized");
    const span = this.spanOf(id);
    if (!span) throw new Rejection("unscheduled", "This task has no dates");
    const resource = task.resourceId;
    if (edge === "end") {
      const end = this.calendar.snapHalfBack(at, resource);
      return this.patch(task, { duration: this.validDuration(this.durationBetween(spanStart(span), end, resource)) });
    }
    const placement = this.placeLeaf(task, Math.min(at, spanEnd(span)));
    const start = halfDay(toDay(placement.userStart), placement.startsAfternoon);
    return this.patch(task, { ...placement, duration: this.validDuration(this.durationBetween(start, spanEnd(span), resource)) });
  }

  private setDuration(id: RowId, duration: number): ProjectState {
    return this.patch(this.editableLeaf(id), { duration: this.validDuration(duration) });
  }

  /** Informational: allowed on locked tasks too, but not on milestones or parents (they add up their subtasks). */
  private setActualDuration(id: RowId, days: number | null): ProjectState {
    const task = this.task(id);
    if (isParentTask(this.tree, task)) throw new Rejection("invalid", "Parent tasks add up their subtasks' actual days");
    if (task.duration === 0) throw new Rejection("invalid", "Milestones have no actual work days");
    return this.patch(task, { actualDuration: days === null ? null : this.validDuration(days, "Actual work days") });
  }

  private convertMilestone(id: RowId, milestone: boolean): ProjectState {
    const task = this.editableLeaf(id);
    // A milestone is a point on its day: it's placed on the morning.
    if (milestone) return this.patch(task, { duration: 0, actualDuration: null, startsAfternoon: false });
    return this.patch(task, { duration: task.duration === 0 ? 1 : task.duration });
  }

  private setLocked(id: RowId, locked: boolean): ProjectState {
    // Unlocking is allowed on any task (a locked leaf may since have become a parent).
    if (!locked) return this.patch(this.task(id), { locked });
    const task = this.leaf(id);
    const span = this.spanOf(id);
    return this.patch(task, locked && span ? { locked, ...startAt(spanStart(span)) } : { locked });
  }

  // ── dependencies ────────────────────────────────────────────────────────

  private linkTasks(fromId: RowId, toId: RowId): ProjectState {
    if (fromId === toId) throw new Rejection("invalid", "A task cannot depend on itself");
    this.task(fromId);
    const successor = this.task(toId);
    if (!this.spanOf(fromId) || !this.spanOf(toId)) throw new Rejection("unscheduled", "Both tasks need dates before they can be linked");
    // `toId` follows `fromId` as asked; if it starts earlier, scheduling places it after its
    // predecessor (its own start stays its "not before" date).
    for (const link of this.fsLinksInto(successor.id)) delete this.links[linkKey(link)];
    this.putLink({ predecessorId: fromId, followerId: successor.id, kind: "FS", lag: 0 });
    return this.result();
  }

  private removePredecessor(id: RowId): ProjectState {
    const task = this.task(id);
    const links = this.fsLinksInto(id);
    if (links.length === 0) throw new Rejection("invalid", "This task has no predecessor");
    this.detachPredecessor(task, links);
    return this.result();
  }

  private setOffset(id: RowId, offset: number): ProjectState {
    if (!Number.isInteger(offset * 2) || Math.abs(offset) > MAX_LAG) {
      throw new Rejection("invalid", `Offset must be in whole or half days, between -${MAX_LAG} and ${MAX_LAG}`);
    }
    const task = this.task(id);
    const link = this.fsLinksInto(id)[0];
    if (!link) throw new Rejection("invalid", "This task has no predecessor");
    // A parent's locked flag has no effect on scheduling.
    const isParent = isParentTask(this.tree, task);
    if (task.locked && !isParent) throw new Rejection("locked", "This task's dates are locked");
    const predecessor = this.spanOf(link.predecessorId);
    if (isParent || !predecessor) return this.putLink({ ...link, lag: offset });

    const resource = task.resourceId;
    const natural = naturalStart(this.calendar, predecessor, resource);
    const floor = floorStart(this.calendar, predecessor, resource);
    const clamped = Math.max(offset * 2, this.calendar.workingHalvesBetween(natural, floor, resource));
    this.putLink({ ...link, lag: clamped / 2 });
    return this.patch(task, startAt(this.calendar.addWorkingHalves(natural, clamped, resource)));
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  /**
   * A task that stopped being a parent (its last subtask was deleted or moved away) keeps
   * the dates it was shown with, instead of reverting to its stale own start and duration.
   */
  private settleFormerParents(): void {
    const after = buildTree(this.result());
    for (const before of Object.values(this.state.rows)) {
      const current = this.rows[before.id];
      if (current?.kind !== "task" || !isParentTask(this.tree, before) || isParentTask(after, current)) continue;
      const span = this.spanOf(before.id);
      if (!span) continue;
      let halves = 0;
      for (let half = spanStart(span); half <= spanEnd(span) && halves < MAX_DURATION * 2; half++) {
        if (this.calendar.isWorkingDay(dayOf(half), current.resourceId)) halves++;
      }
      this.patch(current, { ...startAt(spanStart(span)), duration: Math.max(0.5, halves / 2) });
    }
  }

  /**
   * Stored inputs for putting a leaf task at `target`: never before the constraints inherited
   * from ancestor tasks (whose lags stay as they are), and never on/before its own
   * predecessors' starts; dropping it before a predecessor's natural start records the overlap as
   * a negative lag on that link, dropping it at/after the natural start resets the lag to 0.
   * Predecessors in `moving` move along with the task, so they neither clamp nor re-anchor it.
   */
  private placeLeaf(
    task: TaskRow,
    target: HalfDay,
    moving: ReadonlySet<RowId> = new Set(),
    spanOf: (id: RowId) => Span | null = (id) => this.spanOf(id),
  ): { userStart: IsoDate; startsAfternoon: boolean } {
    const resource = task.resourceId;
    const inherited = constraintsFor(this.result(), task, false);
    const half = Math.max(
      this.calendar.snapHalf(target, resource),
      requiredStart(
        this.calendar,
        task,
        inherited.filter(({ predecessorId }) => !moving.has(predecessorId)).map((link) => ({ link, span: spanOf(link.predecessorId) })),
      ),
    );
    return startAt(this.anchor(task, half, resource, moving, spanOf));
  }

  /**
   * Clamps `half` to after the start of each scheduled predecessor `task` follows (FS) and records,
   * on each of those links, the overlap with that predecessor's natural start as its lag (in days).
   */
  private anchor(
    task: TaskRow,
    half: HalfDay,
    resource: ResourceId | null,
    moving: ReadonlySet<RowId> = new Set(),
    spanOf: (id: RowId) => Span | null = (id) => this.spanOf(id),
  ): HalfDay {
    const anchored: { link: Link; span: Span }[] = [];
    for (const link of this.fsLinksInto(task.id)) {
      const span = moving.has(link.predecessorId) ? null : spanOf(link.predecessorId);
      if (span) anchored.push({ link, span });
    }
    let clamped = half;
    for (const { span } of anchored) clamped = Math.max(clamped, floorStart(this.calendar, span, resource));
    for (const { link, span } of anchored) {
      const natural = naturalStart(this.calendar, span, resource);
      this.putLink({ ...link, lag: clamped < natural ? this.calendar.workingHalvesBetween(natural, clamped, resource) / 2 : 0 });
    }
    return clamped;
  }

  /** Tasks in the subtree that a drag of `id` actually moves: unlocked scheduled leaves and parents containing one. */
  private movingIds(id: RowId): Set<RowId> {
    const movable = (leaf: TaskRow) => !leaf.locked && this.spanOf(leaf.id) !== null;
    const moving = new Set<RowId>();
    for (const subId of subtreeIds(this.tree, id)) {
      const row = this.state.rows[subId];
      if (row?.kind !== "task") continue;
      const moves = isParentTask(this.tree, row) ? descendantLeafTasks(this.tree, subId).some(movable) : movable(row);
      if (moves) moving.add(subId);
    }
    return moving;
  }

  /**
   * Removes `links` into the task while keeping it visually where it is. For a parent, the
   * subtasks its constraints were pushing are pinned at their current start; the others keep
   * following their own constraints.
   */
  private detachPredecessor(task: TaskRow, links: readonly Link[]): void {
    for (const link of links) delete this.links[linkKey(link)];
    const isParent = isParentTask(this.tree, task);
    const span = isParent ? null : this.spanOf(task.id);
    if (span) this.patch(task, startAt(spanStart(span)));
    if (!isParent) return;
    const remaining = (id: RowId) => (this.rows[id] ? this.spanOf(id) : null);
    for (const leaf of descendantLeafTasks(this.tree, task.id)) {
      const current = this.rows[leaf.id]; // deleted subtasks (deleteRows) must not come back
      const leafSpan = this.spanOf(leaf.id);
      if (current?.kind !== "task" || !leafSpan || current.locked || current.userStart === null) continue;
      const resource = current.resourceId;
      const constraints = constraintsFor(this.result(), current).map((link) => ({ link, span: remaining(link.predecessorId) }));
      const required = requiredStart(this.calendar, current, constraints);
      const withoutParent = this.calendar.snapHalf(Math.max(halfDay(toDay(current.userStart), current.startsAfternoon), required), resource);
      if (withoutParent !== spanStart(leafSpan)) this.patch(current, startAt(spanStart(leafSpan)));
    }
  }

  /** Whole or half working days, from half a day up to MAX_DURATION. */
  private validDuration(duration: number, what = "Duration"): number {
    if (!Number.isInteger(duration * 2) || duration < 0.5 || duration > MAX_DURATION) {
      throw new Rejection("invalid", `${what} must be in whole or half days, from 0.5 to ${MAX_DURATION}`);
    }
    return duration;
  }

  /** Parses a date input, rejecting dates outside the supported range. */
  private day(iso: IsoDate): DayNum {
    const day = toDay(iso);
    if (iso < MIN_DATE || iso > MAX_DATE) throw new Rejection("invalid", `Dates must be between ${MIN_DATE} and ${MAX_DATE}`);
    return day;
  }

  /** Working days from half day `start` through half day `end` (both working), at least half a day. */
  private durationBetween(start: HalfDay, end: HalfDay, resource: ResourceId | null): number {
    return end < start ? 0.5 : (this.calendar.workingHalvesBetween(start, end, resource) + 1) / 2;
  }

  private assertValidParent(kind: Row["kind"], parentId: RowId | null): void {
    if (parentId === null) return;
    const parent = this.row(parentId);
    if (kind === "section" && parent.kind === "task") throw new Rejection("invalid", "Sections cannot be placed inside tasks");
  }

  /** A position key right after `afterId` (or first, when null) among the children of `parentId`. */
  private positionAfter(parentId: RowId | null, afterId: RowId | null, movingId?: RowId): string {
    const siblings = childrenOf(this.tree, parentId).filter((sibling) => sibling.id !== movingId);
    if (afterId === null) return keyBetween(null, siblings[0]?.position ?? null);
    const index = siblings.findIndex((sibling) => sibling.id === afterId);
    if (index < 0) throw new Rejection("invalid", `Row ${afterId} is not a child of the target parent`);
    return keyBetween(siblings[index]!.position, siblings[index + 1]?.position ?? null);
  }

  private lastChildId(parentId: RowId): RowId | null {
    const children = childrenOf(this.tree, parentId);
    return children[children.length - 1]?.id ?? null;
  }

  private spanOf(id: RowId): Span | null {
    this.cachedSchedule ??= computeSchedule(this.state, this.calendar);
    return this.cachedSchedule.get(id)?.span ?? null;
  }

  private row(id: RowId): Row {
    const row = this.rows[id];
    if (!row) throw new Rejection("not_found", `Row ${id} does not exist`);
    return row;
  }

  private task(id: RowId): TaskRow {
    const row = this.row(id);
    if (row.kind !== "task") throw new Rejection("invalid", "Only tasks support this");
    return row;
  }

  private leaf(id: RowId): TaskRow {
    const task = this.task(id);
    if (isParentTask(this.tree, task)) throw new Rejection("invalid", "Parent task dates come from their subtasks");
    return task;
  }

  private editableLeaf(id: RowId): TaskRow {
    const task = this.leaf(id);
    if (task.locked) throw new Rejection("locked", "This task's dates are locked");
    return task;
  }

  private patch<R extends Row>(row: R, fields: Partial<R>): ProjectState {
    const current = this.rows[row.id] as R;
    this.rows[row.id] = { ...current, ...fields };
    return this.result();
  }

  /** The FS links into `id`, by key. */
  private fsLinksInto(id: RowId): Link[] {
    return linksInto(this.result(), id).filter((link) => link.kind === "FS");
  }

  private putLink(link: Link): ProjectState {
    this.links[linkKey(link)] = link;
    return this.result();
  }

  private result(): ProjectState {
    return { rows: this.rows, links: this.links };
  }
}

/** Stored inputs for a task starting at `half`. */
function startAt(half: HalfDay): { userStart: IsoDate; startsAfternoon: boolean } {
  return { userStart: fromDay(dayOf(half)), startsAfternoon: isAfternoon(half) };
}

/** generateKeyBetween, with its errors (e.g. corrupt or equal sibling positions) turned into rejections. */
function keyBetween(before: string | null, after: string | null): string {
  try {
    return generateKeyBetween(before, after);
  } catch (error) {
    throw new Rejection("invalid", `Cannot order rows here: ${error instanceof Error ? error.message : String(error)}`);
  }
}
