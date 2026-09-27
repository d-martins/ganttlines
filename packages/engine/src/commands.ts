import { generateKeyBetween } from "fractional-indexing";
import type { Calendar, ResourceId } from "./calendar";
import { diffRows, type RowChange } from "./changes";
import { fromDay, toDay, type DayNum, type IsoDate } from "./date";
import { TASK_COLORS, TASK_DEFAULTS, type ProjectState, type Row, type RowId, type TaskColor, type TaskRow } from "./model";
import { computeSchedule, constraintsFor, CycleError, hasCycle, type Schedule, type Span } from "./schedule";
import { buildTree, childrenOf, descendantLeafTasks, isAncestor, isParentTask, subtreeIds, type Tree } from "./tree";

export type Command =
  | { type: "createRow"; id: RowId; kind: "task" | "section"; parentId: RowId | null; afterId: RowId | null; title: string; start?: IsoDate }
  | { type: "updateTitle"; id: RowId; title: string }
  | { type: "setDescription"; id: RowId; description: string }
  | { type: "setColor"; id: RowId; color: TaskColor }
  | { type: "toggleCollapsed"; id: RowId; collapsed: boolean }
  | { type: "setAssignee"; id: RowId; resourceId: ResourceId | null }
  | { type: "moveTask"; id: RowId; start: IsoDate }
  | { type: "resizeTask"; id: RowId; edge: "start" | "end"; date: IsoDate }
  | { type: "setDuration"; id: RowId; duration: number }
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
export const MAX_OFFSET = 3660;
export const MIN_DATE: IsoDate = "1970-01-01";
export const MAX_DATE: IsoDate = "2199-12-31";

export type RejectReason = "not_found" | "invalid" | "locked" | "cycle" | "unscheduled";

export type CommandResult =
  | { ok: true; state: ProjectState; changes: RowChange[] }
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
    return { ok: true, state: next, changes: diffRows(state, next) };
  } catch (error) {
    if (error instanceof Rejection) return { ok: false, reason: error.reason, message: error.message };
    if (error instanceof CycleError) return { ok: false, reason: "cycle", message: error.message };
    if (error instanceof RangeError) return { ok: false, reason: "invalid", message: error.message };
    throw error;
  }
}

class Execution {
  private readonly rows: Record<RowId, Row>;
  private readonly tree: Tree;
  private cachedSchedule: Schedule | undefined;

  constructor(
    private readonly state: ProjectState,
    private readonly calendar: Calendar,
  ) {
    this.rows = { ...state.rows };
    this.tree = buildTree(state);
  }

  run(command: Command): ProjectState {
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
      case "toggleCollapsed":
        return this.patch(this.row(command.id), { collapsed: command.collapsed });
      case "setAssignee":
        return this.patch(this.task(command.id), { resourceId: command.resourceId });
      case "moveTask":
        return this.moveTask(command.id, this.day(command.start));
      case "resizeTask":
        return this.resizeTask(command.id, command.edge, this.day(command.date));
      case "setDuration":
        return this.setDuration(command.id, command.duration);
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
    const base = { id: command.id, title: command.title, parentId: command.parentId, position, collapsed: false };
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
    for (const row of Object.values(this.rows)) {
      if (row.kind === "task" && row.predecessorId !== null && removed.has(row.predecessorId)) {
        this.detachPredecessor(row);
      }
    }
    return this.result();
  }

  private duplicateTask(id: RowId, newId: RowId): ProjectState {
    const original = this.leaf(id);
    if (this.rows[newId]) throw new Rejection("invalid", `Row ${newId} already exists`);
    this.rows[newId] = { ...original, id: newId, position: this.positionAfter(original.parentId, original.id) };
    return this.result();
  }

  // ── dates ───────────────────────────────────────────────────────────────

  private moveTask(id: RowId, target: DayNum): ProjectState {
    const task = this.task(id);
    if (!isParentTask(this.tree, task)) return this.patch(this.editableLeaf(id), this.placeLeaf(task, target));

    const span = this.spanOf(id);
    if (!span) throw new Rejection("unscheduled", "This parent task has no scheduled subtasks");
    // The parent's own predecessor follows the leaf rule, measured on the unassigned calendar.
    let day = this.calendar.snap(target, null);
    const predecessor = task.predecessorId === null ? null : this.spanOf(task.predecessorId);
    if (predecessor) {
      const anchored = this.anchor(predecessor, day, null);
      day = anchored.day;
      this.patch(task, { offset: anchored.offset });
    }
    const delta = this.calendar.workingDaysBetween(span.start, day, null);
    const moving = this.movingIds(id);
    const moved: RowId[] = [];
    for (const leaf of descendantLeafTasks(this.tree, id)) {
      const leafSpan = this.spanOf(leaf.id);
      if (!leafSpan || leaf.locked) continue;
      const shifted = this.calendar.addWorkingDays(leafSpan.start, delta, leaf.resourceId);
      this.patch(leaf, this.placeLeaf(leaf, shifted, moving));
      moved.push(leaf.id);
    }
    // Store exactly what the schedule will show, so the drag is never silently undone.
    const schedule = computeSchedule(this.result(), this.calendar);
    for (const leafId of moved) {
      const leafSpan = schedule.get(leafId)?.span;
      if (leafSpan) this.patch(this.rows[leafId] as TaskRow, { userStart: fromDay(leafSpan.start) });
    }
    return this.result();
  }

  private resizeTask(id: RowId, edge: "start" | "end", date: DayNum): ProjectState {
    const task = this.editableLeaf(id);
    if (task.duration === 0) throw new Rejection("invalid", "Milestones cannot be resized");
    const span = this.spanOf(id);
    if (!span) throw new Rejection("unscheduled", "This task has no dates");
    const resource = task.resourceId;
    if (edge === "end") {
      const end = this.calendar.snapBack(date, resource);
      return this.patch(task, { duration: this.validDuration(this.durationBetween(span.start, end, resource)) });
    }
    const placement = this.placeLeaf(task, Math.min(date, span.end));
    const start = toDay(placement.userStart);
    return this.patch(task, { ...placement, duration: this.validDuration(this.durationBetween(start, span.end, resource)) });
  }

  private setDuration(id: RowId, duration: number): ProjectState {
    return this.patch(this.editableLeaf(id), { duration: this.validDuration(duration) });
  }

  private convertMilestone(id: RowId, milestone: boolean): ProjectState {
    const task = this.editableLeaf(id);
    return this.patch(task, { duration: milestone ? 0 : task.duration === 0 ? 1 : task.duration });
  }

  private setLocked(id: RowId, locked: boolean): ProjectState {
    // Unlocking is allowed on any task (a locked leaf may since have become a parent).
    if (!locked) return this.patch(this.task(id), { locked });
    const task = this.leaf(id);
    const span = this.spanOf(id);
    return this.patch(task, locked && span ? { locked, userStart: fromDay(span.start) } : { locked });
  }

  // ── dependencies ────────────────────────────────────────────────────────

  private linkTasks(fromId: RowId, toId: RowId): ProjectState {
    if (fromId === toId) throw new Rejection("invalid", "A task cannot depend on itself");
    const from = this.task(fromId);
    const to = this.task(toId);
    const fromSpan = this.spanOf(fromId);
    const toSpan = this.spanOf(toId);
    if (!fromSpan || !toSpan) throw new Rejection("unscheduled", "Both tasks need dates before they can be linked");
    const [predecessor, successor] = toSpan.start < fromSpan.start ? [to, from] : [from, to];
    return this.patch(successor, { predecessorId: predecessor.id, offset: 0 });
  }

  private removePredecessor(id: RowId): ProjectState {
    const task = this.task(id);
    if (task.predecessorId === null) throw new Rejection("invalid", "This task has no predecessor");
    this.detachPredecessor(task);
    return this.result();
  }

  private setOffset(id: RowId, offset: number): ProjectState {
    if (!Number.isInteger(offset) || Math.abs(offset) > MAX_OFFSET) {
      throw new Rejection("invalid", `Offset must be a whole number of days between -${MAX_OFFSET} and ${MAX_OFFSET}`);
    }
    const task = this.task(id);
    if (task.predecessorId === null) throw new Rejection("invalid", "This task has no predecessor");
    // A parent's locked flag has no effect on scheduling.
    const isParent = isParentTask(this.tree, task);
    if (task.locked && !isParent) throw new Rejection("locked", "This task's dates are locked");
    const predecessor = this.spanOf(task.predecessorId);
    if (isParent || !predecessor) return this.patch(task, { offset });

    const resource = task.resourceId;
    const natural = this.calendar.nextAfter(predecessor.end, resource);
    const floor = this.calendar.nextAfter(predecessor.start, resource);
    const clamped = Math.max(offset, this.calendar.workingDaysBetween(natural, floor, resource));
    return this.patch(task, {
      offset: clamped,
      userStart: fromDay(this.calendar.addWorkingDays(natural, clamped, resource)),
    });
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  /**
   * Stored inputs for putting a leaf task at `target`: never before the constraints inherited
   * from ancestor tasks (whose offsets stay as they are), and never on/before its own
   * predecessor's start; dropping it before the natural start records the overlap as a
   * negative offset, dropping it at/after the natural start resets the offset to 0.
   * Predecessors in `moving` move along with the task, so they neither clamp nor re-anchor it.
   */
  private placeLeaf(task: TaskRow, target: DayNum, moving: ReadonlySet<RowId> = new Set()): { userStart: IsoDate; offset?: number } {
    const resource = task.resourceId;
    let day = this.calendar.snap(target, resource);
    for (const inherited of constraintsFor(this.result(), { ...task, predecessorId: null })) {
      const span = moving.has(inherited.predecessorId) ? null : this.spanOf(inherited.predecessorId);
      if (!span) continue;
      const natural = this.calendar.nextAfter(span.end, resource);
      day = Math.max(day, this.calendar.addWorkingDays(natural, inherited.offset, resource), this.calendar.nextAfter(span.start, resource));
    }
    const predecessorId = task.predecessorId;
    const predecessor = predecessorId === null || moving.has(predecessorId) ? null : this.spanOf(predecessorId);
    if (!predecessor) return { userStart: fromDay(day) };
    const anchored = this.anchor(predecessor, day, resource);
    return { userStart: fromDay(anchored.day), offset: anchored.offset };
  }

  /** Clamps `day` to after the predecessor's start and expresses it as an offset from the natural start. */
  private anchor(predecessor: Span, day: DayNum, resource: ResourceId | null): { day: DayNum; offset: number } {
    const clamped = Math.max(day, this.calendar.nextAfter(predecessor.start, resource));
    const natural = this.calendar.nextAfter(predecessor.end, resource);
    return { day: clamped, offset: clamped < natural ? this.calendar.workingDaysBetween(natural, clamped, resource) : 0 };
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

  /** Removes the predecessor while keeping the task (or, for a parent, each subtask) visually where it is. */
  private detachPredecessor(task: TaskRow): void {
    const isParent = isParentTask(this.tree, task);
    // Deleted subtasks (deleteRows) are skipped: patching them would bring them back.
    for (const leaf of isParent ? descendantLeafTasks(this.tree, task.id) : []) {
      const span = this.spanOf(leaf.id);
      if (span && !leaf.locked && this.rows[leaf.id]) this.patch(leaf, { userStart: fromDay(span.start) });
    }
    const span = isParent ? null : this.spanOf(task.id);
    this.patch(task, span ? { predecessorId: null, offset: 0, userStart: fromDay(span.start) } : { predecessorId: null, offset: 0 });
  }

  private validDuration(duration: number): number {
    if (!Number.isInteger(duration) || duration < 1 || duration > MAX_DURATION) {
      throw new Rejection("invalid", `Duration must be a whole number of days from 1 to ${MAX_DURATION}`);
    }
    return duration;
  }

  /** Parses a date input, rejecting dates outside the supported range. */
  private day(iso: IsoDate): DayNum {
    const day = toDay(iso);
    if (iso < MIN_DATE || iso > MAX_DATE) throw new Rejection("invalid", `Dates must be between ${MIN_DATE} and ${MAX_DATE}`);
    return day;
  }

  private durationBetween(start: DayNum, end: DayNum, resource: ResourceId | null): number {
    return end < start ? 1 : this.calendar.workingDaysBetween(start, end, resource) + 1;
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

  private result(): ProjectState {
    return { rows: this.rows };
  }
}

/** generateKeyBetween, with its errors (e.g. corrupt or equal sibling positions) turned into rejections. */
function keyBetween(before: string | null, after: string | null): string {
  try {
    return generateKeyBetween(before, after);
  } catch (error) {
    throw new Rejection("invalid", `Cannot order rows here: ${error instanceof Error ? error.message : String(error)}`);
  }
}
