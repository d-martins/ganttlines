import { generateKeyBetween } from "fractional-indexing";
import type { Calendar, ResourceId } from "./calendar";
import { diffState, type Change } from "./changes";
import { dayOf, fromDay, halfDay, isAfternoon, toDay, type DayNum, type HalfDay, type IsoDate } from "./date";
import { LINK_KINDS, linkKey, MAX_LAG, MAX_LINKS_PER_TASK, type Link, type LinkKey, type LinkKind, type LinkRef } from "./links";
import { TASK_COLORS, TASK_DEFAULTS, type ProjectState, type Row, type RowId, type TaskColor, type TaskRow } from "./model";
import {
  computeSchedule,
  constraintsFor,
  CycleError,
  hasCycle,
  floorStart,
  indexByFollower,
  linkFloor,
  linkRequirement,
  naturalStart,
  requiredStart,
  spanEnd,
  spanStart,
  type FollowerIndex,
  type Schedule,
  type Span,
} from "./schedule";
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
  /** `followerId` waits for `predecessorId` as `kind` says; `lag` defaults to 0. */
  | { type: "addLink"; predecessorId: RowId; followerId: RowId; kind: LinkKind; lag?: number }
  /** Changes the lag, the kind (`newKind`), or both; the link keeps its lag when `lag` is left out. */
  | { type: "updateLink"; predecessorId: RowId; followerId: RowId; kind: LinkKind; lag?: number; newKind?: LinkKind }
  /**
   * `keepPlace` (default true) keeps the follower where it is shown; false leaves its own start
   * as it was, so it moves to where its remaining links and its own date put it.
   */
  | { type: "removeLink"; predecessorId: RowId; followerId: RowId; kind: LinkKind; keepPlace?: boolean }
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
  /** Links by follower, for the links as they are now; dropped whenever a link changes. */
  private cachedIndex: FollowerIndex | undefined;

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
      case "addLink":
        return this.addLink(command, command.lag ?? 0);
      case "updateLink":
        return this.updateLink(command, command.lag, command.newKind);
      case "removeLink":
        if (command.keepPlace === false) this.deleteLink(this.existingLink(command));
        else this.detachLink(this.existingLink(command));
        return this.result();
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
    this.patch(row, { parentId: previous.id, position: this.positionAfter(previous.id, this.lastChildId(previous.id)) });
    return this.dropLinksWithinChains();
  }

  private outdent(id: RowId): ProjectState {
    const row = this.row(id);
    if (row.parentId === null) throw new Rejection("invalid", "Already at the top level");
    const parent = this.row(row.parentId);
    this.patch(row, { parentId: parent.parentId, position: this.positionAfter(parent.parentId, parent.id) });
    return this.dropLinksWithinChains();
  }

  private moveRow(id: RowId, parentId: RowId | null, afterId: RowId | null): ProjectState {
    const row = this.row(id);
    if (parentId === id || (parentId !== null && isAncestor(this.state, id, parentId))) {
      throw new Rejection("invalid", "A row cannot be moved inside itself");
    }
    this.assertValidParent(row.kind, parentId);
    this.patch(row, { parentId, position: this.positionAfter(parentId, afterId, id) });
    return this.dropLinksWithinChains();
  }

  private deleteRows(ids: RowId[]): ProjectState {
    const removed = new Set<RowId>();
    // Ids that no longer exist are ignored: live sessions may send stale selections.
    for (const id of ids) if (this.rows[id]) for (const subId of subtreeIds(this.tree, id)) removed.add(subId);
    for (const id of removed) delete this.rows[id];
    for (const key of Object.keys(this.links).sort()) {
      const link = this.links[key]!;
      // Surviving followers of deleted tasks stay where they are shown.
      if (removed.has(link.followerId)) this.deleteLink(link);
      else if (removed.has(link.predecessorId)) this.detachLink(link);
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
    for (const link of this.linksInto(id)) this.putLink({ ...link, followerId: newId });
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
    // The parent's own FS and SS links follow the leaf rule, measured on the unassigned calendar.
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
      const outside = this.constraintsOf(current).some(({ predecessorId }) => !moving.has(predecessorId));
      if (outside) this.patch(current, this.placeLeaf(current, shifted.get(leaf.id)!, { moving, spanOf: spanIn }));
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
    // The end stays put, so FF links neither clamp the new start nor change their lag.
    const placement = this.placeLeaf(task, Math.min(at, spanEnd(span)), { keepFinish: true });
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

  private addLink(ref: LinkRef, lag: number): ProjectState {
    const { predecessorId, followerId, kind } = ref;
    this.row(predecessorId);
    this.row(followerId);
    this.task(predecessorId);
    this.task(followerId);
    if (!LINK_KINDS.includes(kind)) throw new Rejection("invalid", `Unknown link kind ${kind}`);
    if (predecessorId === followerId) throw new Rejection("invalid", "A task cannot depend on itself");
    if (isAncestor(this.state, predecessorId, followerId) || isAncestor(this.state, followerId, predecessorId)) {
      throw new Rejection("invalid", "A task can't link to its own parent or subtask");
    }
    if (this.links[linkKey(ref)]) throw new Rejection("invalid", "These tasks are already linked that way");
    if (this.linksInto(followerId).length >= MAX_LINKS_PER_TASK) {
      throw new Rejection("invalid", `A task can wait on at most ${MAX_LINKS_PER_TASK} links`);
    }
    this.assertValidLag(kind, lag);
    if (!this.spanOf(predecessorId) || !this.spanOf(followerId)) throw new Rejection("unscheduled", "Both tasks need dates before they can be linked");
    // If the follower starts earlier, scheduling places it after the link (its own start stays
    // its "not before" date).
    return this.putLink({ predecessorId, followerId, kind, lag });
  }

  /**
   * A changed link re-places an unlocked leaf follower at the earliest start all its links allow;
   * an FS lag is clamped so it never starts before the day after its predecessor starts.
   */
  private updateLink(ref: LinkRef, lag: number | undefined, newKind: LinkKind | undefined): ProjectState {
    const link = this.existingLink(ref);
    const kind = newKind ?? link.kind;
    if (!LINK_KINDS.includes(kind)) throw new Rejection("invalid", `Unknown link kind ${kind}`);
    if (kind !== link.kind && this.links[linkKey({ ...link, kind })]) throw new Rejection("invalid", "These tasks are already linked that way");
    // A kind change without a lag keeps the lag, except an overlap only FS can have.
    const nextLag = lag ?? (kind === "FS" ? link.lag : Math.max(0, link.lag));
    this.assertValidLag(kind, nextLag);
    const follower = this.task(link.followerId);
    // A parent's locked flag has no effect on scheduling.
    const isParent = isParentTask(this.tree, follower);
    if (follower.locked && !isParent) throw new Rejection("locked", "This task's dates are locked");
    this.deleteLink(link);
    const updated: Link = { predecessorId: link.predecessorId, followerId: link.followerId, kind, lag: nextLag };
    if (isParent || follower.userStart === null) return this.putLink(updated);

    const resource = follower.resourceId;
    const predecessor = this.spanOf(link.predecessorId);
    if (kind === "FS" && predecessor) {
      const natural = naturalStart(this.calendar, predecessor, resource);
      const floor = floorStart(this.calendar, predecessor, resource);
      updated.lag = Math.max(nextLag * 2, this.calendar.workingHalvesBetween(natural, floor, resource)) / 2;
    }
    this.putLink(updated);
    const constraints = this.constraintsOf(follower).map((constraint) => ({ link: constraint, span: this.spanOf(constraint.predecessorId) }));
    const required = requiredStart(this.calendar, follower, constraints);
    if (required === -Infinity) return this.result();
    return this.patch(follower, startAt(this.calendar.snapHalf(required, resource)));
  }

  /** The link `ref` names; both tasks must exist. */
  private existingLink(ref: LinkRef): Link {
    this.row(ref.predecessorId);
    this.row(ref.followerId);
    const link = this.links[linkKey(ref)];
    if (!link) throw new Rejection("not_found", "These tasks aren't linked that way");
    return link;
  }

  /** Whole or half working days within MAX_LAG; only FS links may overlap (negative lag). */
  private assertValidLag(kind: LinkKind, lag: number): void {
    if (typeof lag !== "number" || !Number.isInteger(lag * 2) || Math.abs(lag) > MAX_LAG) {
      throw new Rejection("invalid", `Delays must be in whole or half days, between -${MAX_LAG} and ${MAX_LAG}`);
    }
    if (kind !== "FS" && lag < 0) throw new Rejection("invalid", "Only “after it finishes” links can overlap");
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
   * from ancestor tasks (whose lags stay as they are), and never before the floor of any of its
   * own links (see `anchor`), which then record where it was dropped.
   * Predecessors in `moving` move along with the task, so they neither clamp nor re-anchor it;
   * `keepFinish` (the end stays where it is) leaves its FF links alone.
   */
  private placeLeaf(
    task: TaskRow,
    target: HalfDay,
    {
      moving = new Set<RowId>(),
      spanOf = (id: RowId) => this.spanOf(id),
      keepFinish = false,
    }: { moving?: ReadonlySet<RowId>; spanOf?: (id: RowId) => Span | null; keepFinish?: boolean } = {},
  ): { userStart: IsoDate; startsAfternoon: boolean } {
    const resource = task.resourceId;
    const inherited = this.constraintsOf(task, false);
    const half = Math.max(
      this.calendar.snapHalf(target, resource),
      requiredStart(
        this.calendar,
        task,
        inherited.filter(({ predecessorId }) => !moving.has(predecessorId)).map((link) => ({ link, span: spanOf(link.predecessorId) })),
      ),
    );
    return startAt(this.anchor(task, half, resource, moving, spanOf, keepFinish));
  }

  /**
   * Clamps `half` to the floor of each of `task`'s own links with a scheduled predecessor (FS: the
   * day after the predecessor starts; SS: its start; FF: the start that ends with it) and records
   * the drop on the links that hold it back: their lag becomes the one that starts it exactly there
   * (FS: the overlap with the predecessor's natural start, in days; SS and FF: never below 0). Links
   * that don't hold it back keep their lag, except an FS overlap, which shrinks back toward 0 (it
   * never overlaps more than the drop). FF links into a parent stretch it instead, so they are left
   * alone, as they are with `keepFinish`.
   */
  private anchor(
    task: TaskRow,
    half: HalfDay,
    resource: ResourceId | null,
    moving: ReadonlySet<RowId> = new Set(),
    spanOf: (id: RowId) => Span | null = (id) => this.spanOf(id),
    keepFinish = false,
  ): HalfDay {
    const skipFinish = keepFinish || isParentTask(this.tree, task);
    const follower = { resourceId: resource, duration: task.duration };
    const anchored: { link: Link; span: Span }[] = [];
    for (const link of this.linksInto(task.id)) {
      if (skipFinish && link.kind === "FF") continue;
      const span = moving.has(link.predecessorId) ? null : spanOf(link.predecessorId);
      if (span) anchored.push({ link, span });
    }
    let clamped = half;
    for (const { link, span } of anchored) clamped = Math.max(clamped, linkFloor(this.calendar, follower, link, span));
    for (const { link, span } of anchored) {
      const required = linkRequirement(this.calendar, follower, link, span);
      const holdsBack = required > clamped;
      if (link.kind === "FS") {
        if (!holdsBack && link.lag > 0) continue;
        const overlap = this.calendar.workingHalvesBetween(naturalStart(this.calendar, span, resource), clamped, resource) / 2;
        this.patchLink(link, { lag: holdsBack ? overlap : Math.min(0, overlap) });
      } else if (holdsBack) {
        const excess = this.calendar.workingHalvesBetween(clamped, required, resource) / 2;
        this.patchLink(link, { lag: Math.max(0, link.lag - excess) });
      }
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
   * Removes `link` while keeping its follower visually where it is: a leaf keeps its current start;
   * for a parent, the subtasks an FS or SS link was pushing are pinned at their current start (the
   * others keep following their own constraints), while an FF link only stretched the parent, which
   * snaps back to its subtasks.
   */
  private detachLink(link: Link): void {
    this.deleteLink(link);
    const task = this.rows[link.followerId];
    if (task?.kind !== "task") return;
    if (!isParentTask(this.tree, task)) {
      const span = this.spanOf(task.id);
      if (span) this.patch(task, startAt(spanStart(span)));
      return;
    }
    if (link.kind === "FF") return;
    const remaining = (id: RowId) => (this.rows[id] ? this.spanOf(id) : null);
    for (const leaf of descendantLeafTasks(this.tree, task.id)) {
      const current = this.rows[leaf.id]; // deleted subtasks (deleteRows) must not come back
      const leafSpan = this.spanOf(leaf.id);
      if (current?.kind !== "task" || !leafSpan || current.locked || current.userStart === null) continue;
      const resource = current.resourceId;
      const constraints = this.constraintsOf(current).map((constraint) => ({ link: constraint, span: remaining(constraint.predecessorId) }));
      const required = requiredStart(this.calendar, current, constraints);
      const withoutParent = this.calendar.snapHalf(Math.max(halfDay(toDay(current.userStart), current.startsAfternoon), required), resource);
      if (withoutParent !== spanStart(leafSpan)) this.patch(current, startAt(spanStart(leafSpan)));
    }
  }

  /** Removes the links a move left between a task and one of its ancestors, as removeLink does. */
  private dropLinksWithinChains(): ProjectState {
    const state = this.result();
    for (const key of Object.keys(this.links).sort()) {
      const link = this.links[key]!;
      if (isAncestor(state, link.predecessorId, link.followerId) || isAncestor(state, link.followerId, link.predecessorId)) this.detachLink(link);
    }
    return this.result();
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

  /** The links `id` follows, by key. */
  private linksInto(id: RowId): readonly Link[] {
    this.cachedIndex ??= indexByFollower(this.result());
    return this.cachedIndex.get(id) ?? [];
  }

  private constraintsOf(task: TaskRow, own = true): Link[] {
    this.cachedIndex ??= indexByFollower(this.result());
    return constraintsFor(this.result(), task, own, this.cachedIndex);
  }

  private putLink(link: Link): ProjectState {
    this.links[linkKey(link)] = link;
    this.cachedIndex = undefined;
    return this.result();
  }

  private patchLink(ref: LinkRef, fields: Partial<Pick<Link, "lag">>): ProjectState {
    return this.putLink({ ...this.links[linkKey(ref)]!, ...fields });
  }

  private deleteLink(ref: LinkRef): void {
    delete this.links[linkKey(ref)];
    this.cachedIndex = undefined;
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
