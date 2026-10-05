import { Prisma, toDbColumns, type Db, type Project } from "@ganttlines/db";
import {
  applyChanges,
  applyCommand,
  buildTree,
  childrenOf,
  computeSchedule,
  diffRows,
  fromDay,
  hasCycle,
  isParentTask,
  type Command,
  type ProjectState,
  type Row,
  type RowChange,
  type Span,
} from "@ganttlines/engine";
import type { BaselineTaskDto, ChangesDto, CommandResultDto, ProjectDto, ProjectStateDto } from "@ganttlines/protocol";
import { createHash } from "node:crypto";
import { actorKey, type Actor } from "../actor";
import type { InstanceService } from "../calendar/instance-service";
import { NoLock } from "../cluster/local";
import type { EventBus, ProjectLock } from "../cluster/types";
import { toProjectDto } from "../dto";
import { conflict, HttpError, notFound } from "../errors";
import { KeyedQueue } from "../queue";
import { findTreeProblem, readProject, type StoredProject } from "./state";
import { revertChanges, UndoStacks } from "./undo";

/** Clients further behind than this (in versions or in total changes) reload instead of replaying. */
export const MAX_CATCH_UP = 500;
export const MAX_CATCH_UP_CHANGES = 20_000;
/** Large commands (e.g. deleting thousands of rows) must not hit Prisma's 5 s default. */
const TRANSACTION_TIMEOUT_MS = 30_000;
/** Recently seen commands that changed nothing or were rejected (not in the command log). */
const RECENT_OUTCOMES = 1_000;

type Tx = Prisma.TransactionClient;

export interface AppliedEvent {
  projectId: string;
  version: number;
  commandId: string;
  actor: Actor;
  changes: RowChange[];
}

export interface UndoResultDto extends CommandResultDto {
  /** changes that were left alone because someone edited them since */
  skipped: number;
}

/** Outcome of a command that is not in the command log; `digest` identifies the exact request. */
type Outcome = { ok: true; result: UndoResultDto | CommandResultDto; digest: string } | { ok: false; error: HttpError; digest: string };

/**
 * Authoritative project state: an in-memory copy per project (loaded on first use) that every
 * command goes through, one command at a time per project. Each applied command is persisted
 * together with its command-log entry and a version bump in a single transaction, then announced
 * to listeners (the real-time hub) in version order.
 */
/** A row as the board lists it: its depth, whether it's a parent task, and its computed dates. */
export interface OutlineRow {
  row: Row;
  depth: number;
  isParent: boolean;
  /** null for sections and unscheduled tasks */
  span: Span | null;
}

export class ProjectService {
  private readonly cache = new Map<string, Promise<StoredProject>>();
  private readonly queue = new KeyedQueue();
  private readonly recent = new Map<string, Outcome>();
  private readonly undoStacks = new UndoStacks();
  private readonly appliedListeners = new Set<(event: AppliedEvent) => void>();
  private readonly metaListeners = new Set<(project: ProjectDto) => void>();

  constructor(
    private readonly db: Db,
    private readonly instance: InstanceService,
    /** several copies: changes take turns through `lock`, and cached boards are checked against the database */
    private readonly cluster: { lock: ProjectLock; shared: boolean; bus?: EventBus } = { lock: new NoLock(), shared: false },
  ) {}

  onApplied(listener: (event: AppliedEvent) => void): () => void {
    this.appliedListeners.add(listener);
    return () => this.appliedListeners.delete(listener);
  }

  onMetaChange(listener: (project: ProjectDto) => void): () => void {
    this.metaListeners.add(listener);
    return () => this.metaListeners.delete(listener);
  }

  state(projectId: string): Promise<ProjectStateDto> {
    return this.queue.run(projectId, async () => {
      const { meta, state } = await this.load(projectId);
      return { project: toProjectDto(meta), rows: Object.values(state.rows) };
    });
  }

  /** Applies a command. Retrying with the same `commandId` returns the original outcome. */
  apply(projectId: string, actor: Actor, commandId: string, command: Command): Promise<CommandResultDto> {
    return this.run(projectId, async (stored) => {
      const digest = digestOf(command);
      const previous = await this.previousOutcome(projectId, commandId, digest, (logged) => digestOf(logged.payload));
      if (previous) return previous;
      return this.remember(projectId, commandId, digest, async () => {
        if (stored.meta.archivedAt) throw conflict("This project is archived");
        await this.checkReferences(stored, command);
        const result = applyCommand(stored.state, (await this.instance.current()).calendar, command);
        if (!result.ok) throw new HttpError(422, result.reason, result.message);
        if (result.changes.length === 0) return { version: stored.meta.version, changes: [] };
        const applied = await this.commit(stored, actor, commandId, command.type, command, result.state, result.changes);
        const key = actorKey(actor);
        if (key) this.undoStacks.pushCommand(projectId, key, commandId);
        return applied;
      });
    });
  }

  /** Reverts the actor's most recent command in this project (skip-on-conflict). */
  undo(projectId: string, actor: Actor, commandId: string): Promise<UndoResultDto> {
    return this.revert(projectId, actor, commandId, "undo");
  }

  /** Re-applies the actor's most recently undone command in this project. */
  redo(projectId: string, actor: Actor, commandId: string): Promise<UndoResultDto> {
    return this.revert(projectId, actor, commandId, "redo");
  }

  /** Command-log entries after `since`, or "reload" when the client is too far behind (or ahead). */
  changesSince(projectId: string, since: number): Promise<ChangesDto> {
    return this.queue.run(projectId, async () => {
      const { version } = (await this.load(projectId)).meta;
      if (version - since > MAX_CATCH_UP || since > version) return { version, reload: true };
      const entries = await this.db.commandLog.findMany({ where: { projectId, version: { gt: since } }, orderBy: { version: "asc" } });
      let total = 0;
      for (const entry of entries) total += (entry.changes as unknown as RowChange[]).length;
      if (total > MAX_CATCH_UP_CHANGES) return { version, reload: true };
      return {
        version,
        entries: entries.map((entry) => ({
          version: entry.version,
          commandId: entry.commandId,
          actor: { userId: entry.actorUserId, label: entry.actorLabel },
          changes: entry.changes as unknown as RowChange[],
        })),
      };
    });
  }

  /** Renames or (un)archives a project, keeping the cached copy in step. */
  updateMeta(projectId: string, data: { name?: string; archivedAt?: Date | null }): Promise<Project> {
    return this.locked(projectId, async () => {
      const stored = await this.load(projectId);
      stored.meta = await this.db.project.update({ where: { id: projectId }, data });
      const dto = toProjectDto(stored.meta);
      for (const listener of this.metaListeners) notify(listener, dto);
      return stored.meta;
    });
  }

  /** Whether `rowId` is a task of the project (for attaching comments). */
  hasTask(projectId: string, rowId: string): Promise<boolean> {
    return this.queue.run(projectId, async () => (await this.load(projectId)).state.rows[rowId]?.kind === "task");
  }

  /** The current computed dates of every scheduled task (for baselines). */
  scheduleSnapshot(projectId: string): Promise<BaselineTaskDto[]> {
    return this.queue.run(projectId, async () => {
      const { state } = await this.load(projectId);
      const schedule = computeSchedule(state, (await this.instance.current()).calendar);
      const tree = buildTree(state);
      const tasks: BaselineTaskDto[] = [];
      for (const row of Object.values(state.rows)) {
        const span = schedule.get(row.id)?.span;
        if (row.kind !== "task" || !span) continue;
        const kind = isParentTask(tree, row) ? "parent" : row.duration === 0 ? "milestone" : "task";
        tasks.push({
          rowId: row.id,
          kind,
          title: row.title,
          start: fromDay(span.start),
          end: fromDay(span.end),
          startsAfternoon: span.startsAfternoon,
          endsMidday: span.endsMidday,
        });
      }
      return tasks;
    });
  }

  /** Every row in board order (depth first), with the computed dates of scheduled tasks. */
  outline(projectId: string): Promise<{ project: ProjectDto; rows: OutlineRow[] }> {
    return this.queue.run(projectId, async () => {
      const { meta, state } = await this.load(projectId);
      const schedule = computeSchedule(state, (await this.instance.current()).calendar);
      const tree = buildTree(state);
      const rows: OutlineRow[] = [];
      const visit = (parentId: string | null, depth: number) => {
        for (const row of childrenOf(tree, parentId)) {
          rows.push({ row, depth, isParent: isParentTask(tree, row), span: schedule.get(row.id)?.span ?? null });
          visit(row.id, depth + 1);
        }
      };
      visit(null, 0);
      return { project: toProjectDto(meta), rows };
    });
  }

  /**
   * Deletes an archived project and everything in it (rows, command log, comments, highlights,
   * baselines and share links cascade in the database). Live projects must be archived first.
   */
  remove(projectId: string): Promise<void> {
    return this.locked(projectId, async () => {
      const stored = await this.load(projectId);
      if (!stored.meta.archivedAt) throw conflict("Only archived projects can be deleted — archive it first");
      await this.db.project.delete({ where: { id: projectId } });
      this.cache.delete(projectId);
      this.undoStacks.forgetProject(projectId);
    });
  }

  /** Forgets the cached copy of a project (e.g. when nobody has it open any more). */
  evict(projectId: string): Promise<void> {
    return this.queue.run(projectId, async () => {
      this.cache.delete(projectId);
    });
  }

  private revert(projectId: string, actor: Actor, commandId: string, direction: "undo" | "redo"): Promise<UndoResultDto> {
    return this.run(projectId, async (stored) => {
      const userId = actorKey(actor);
      if (!userId) throw new HttpError(422, "invalid", "Undo needs a known user or visitor");
      // A retried undo/redo (same commandId) returns its first outcome instead of reverting another change.
      const digest = digestOf({ direction, by: userId });
      const previous = await this.previousOutcome(projectId, commandId, digest, (logged) =>
        digestOf({ direction: logged.name, by: (logged.payload as { by?: unknown } | null)?.by }),
      );
      if (previous) return { skipped: 0, ...previous };
      return this.remember(projectId, commandId, digest, async () => {
        if (stored.meta.archivedAt) throw conflict("This project is archived");
        const target = this.undoStacks.peek(direction, projectId, userId);
        if (!target) throw new HttpError(422, "invalid", direction === "undo" ? "Nothing to undo" : "Nothing to redo");
        // From here on the entry is consumed when the revert definitively cannot apply (so the next
        // undo moves on), but kept if the commit fails for an unexpected reason (so it can be retried).
        const discard = (error: HttpError) => {
          this.undoStacks.pop(direction, projectId, userId);
          return error;
        };
        let result: UndoResultDto;
        try {
          result = await this.revertLogged(stored, actor, commandId, direction, target, userId);
        } catch (error) {
          throw error instanceof HttpError && error.status !== 500 ? discard(error) : error;
        }
        this.undoStacks.pop(direction, projectId, userId);
        if (direction === "undo") this.undoStacks.pushUndone(projectId, userId, target);
        else this.undoStacks.pushRedone(projectId, userId, target);
        return result;
      }) as Promise<UndoResultDto>;
    });
  }

  /**
   * Undoes one particular logged command (skip-on-conflict, like undo), outside anyone's undo
   * history — for AI apps undoing their own last tool call.
   */
  undoCommand(projectId: string, actor: Actor, commandId: string, targetCommandId: string): Promise<UndoResultDto> {
    return this.run(projectId, async (stored) => {
      if (stored.meta.archivedAt) throw conflict("This project is archived");
      return this.revertLogged(stored, actor, commandId, "undo", targetCommandId, actorKey(actor));
    });
  }

  private async revertLogged(
    stored: StoredProject,
    actor: Actor,
    commandId: string,
    direction: "undo" | "redo",
    target: string,
    by: string | null,
  ): Promise<UndoResultDto> {
    const projectId = stored.meta.id;
    const logged = await this.db.commandLog.findUnique({ where: { commandId: target } });
    if (!logged || logged.projectId !== projectId) throw new HttpError(422, "invalid", "That change is no longer available");
    const { state, skipped } = revertChanges(stored.state, logged.changes as unknown as RowChange[], direction);
    const problem = findTreeProblem(Object.values(state.rows));
    if (problem || hasCycle(state, (await this.instance.current()).calendar)) {
      throw new HttpError(409, "conflict", `Can't ${direction} this any more: the board changed since`);
    }
    const changes = diffRows(stored.state, state);
    if (changes.length === 0) throw new HttpError(409, "conflict", `Nothing left to ${direction}: it was all changed since`);
    const result = await this.commit(stored, actor, commandId, direction, { target, skipped, by }, state, changes);
    return { ...result, skipped };
  }

  /** Runs `work` in the project's queue; unexpected failures drop the cached copy so the next request reloads. */
  private run<T>(projectId: string, work: (stored: StoredProject) => Promise<T>): Promise<T> {
    return this.locked(projectId, async () => {
      try {
        return await work(await this.load(projectId));
      } catch (error) {
        if (error instanceof HttpError) throw error;
        this.cache.delete(projectId);
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
          throw conflict("The project changed on the server; please retry");
        }
        throw error;
      }
    });
  }

  /** In the project's queue and, with several copies, its lock: changes to a board take turns. */
  private locked<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    return this.queue.run(projectId, () => this.cluster.lock.run(`project:${projectId}`, work));
  }

  /** The cached board, caught up with changes other copies made (several copies only). */
  private async load(projectId: string): Promise<StoredProject> {
    const stored = await this.get(projectId);
    return this.cluster.shared ? this.catchUp(projectId, stored) : stored;
  }

  /**
   * Brings a cached board up to the database's version by replaying the command log; reloads it
   * when it's too far behind (or the log has gaps). Project details (name, archived) are re-read.
   */
  private async catchUp(projectId: string, stored: StoredProject): Promise<StoredProject> {
    const meta = await this.db.project.findUnique({ where: { id: projectId } });
    if (!meta) {
      this.cache.delete(projectId);
      throw notFound("Project");
    }
    const behind = meta.version - stored.meta.version;
    if (behind === 0) {
      stored.meta = meta;
      return stored;
    }
    const entries =
      behind > 0 && behind <= MAX_CATCH_UP
        ? await this.db.commandLog.findMany({ where: { projectId, version: { gt: stored.meta.version, lte: meta.version } }, orderBy: { version: "asc" } })
        : [];
    if (entries.length !== behind) {
      const fresh = readProject(this.db, projectId);
      this.cache.set(projectId, fresh);
      fresh.catch(() => this.cache.delete(projectId));
      return fresh;
    }
    let state = stored.state;
    for (const entry of entries) state = applyChanges(state, entry.changes as unknown as RowChange[]);
    stored.state = state;
    stored.meta = meta;
    return stored;
  }

  /** Persists rows + log entry + version bump atomically, updates the cache, then notifies listeners. */
  private async commit(
    stored: StoredProject,
    actor: Actor,
    commandId: string,
    name: string,
    payload: unknown,
    state: ProjectState,
    changes: RowChange[],
  ): Promise<CommandResultDto> {
    const projectId = stored.meta.id;
    const version = stored.meta.version + 1;
    const meta = await this.db.$transaction(
      async (tx) => {
        await writeRows(tx, projectId, state, changes);
        await tx.commandLog.create({
          data: {
            projectId,
            version,
            commandId,
            actorUserId: actor.userId,
            actorLabel: actor.label,
            actorLinkId: actor.linkId ?? null,
            name,
            payload: payload as Prisma.InputJsonValue,
            changes: changes as unknown as Prisma.InputJsonValue,
          },
        });
        const updated = await tx.project.update({ where: { id: projectId, version: stored.meta.version }, data: { version } });
        // Other copies hear about it exactly when (and if) it commits.
        const notice = this.cluster.bus?.notification({ type: "patch", projectId, version });
        if (notice) await tx.$executeRawUnsafe(notice.sql, ...notice.params);
        return updated;
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    stored.meta = meta;
    stored.state = state;
    const event: AppliedEvent = { projectId, version, commandId, actor, changes };
    for (const listener of this.appliedListeners) notify(listener, event);
    return { version, changes };
  }

  /**
   * The earlier outcome of this commandId in this project (from the command log, or from recent
   * no-ops/rejections), or undefined if it is new. A commandId reused for a different request is a conflict.
   */
  private async previousOutcome(
    projectId: string,
    commandId: string,
    digest: string,
    loggedDigest: (logged: { payload: unknown; name: string; actorUserId: string | null }) => string,
  ): Promise<UndoResultDto | CommandResultDto | undefined> {
    const recent = this.recent.get(`${projectId}:${commandId}`);
    if (recent) {
      if (recent.digest !== digest) throw conflict("This commandId was already used for something else");
      if (!recent.ok) throw recent.error;
      return recent.result;
    }
    const logged = await this.db.commandLog.findUnique({ where: { commandId } });
    if (!logged) return undefined;
    if (logged.projectId !== projectId || loggedDigest(logged) !== digest) {
      throw conflict("This commandId was already used for something else");
    }
    const skipped = (logged.payload as { skipped?: unknown } | null)?.skipped;
    return {
      version: logged.version,
      changes: logged.changes as unknown as RowChange[],
      ...(typeof skipped === "number" ? { skipped } : {}),
    };
  }

  /** Remembers no-op and rejected outcomes (they are not in the log) so a retry gets the same answer. */
  private async remember<T extends CommandResultDto>(projectId: string, commandId: string, digest: string, work: () => Promise<T>): Promise<T> {
    const key = `${projectId}:${commandId}`;
    try {
      const result = await work();
      if (result.changes.length === 0) this.rememberOutcome(key, { ok: true, result, digest });
      return result;
    } catch (error) {
      if (error instanceof HttpError) this.rememberOutcome(key, { ok: false, error, digest });
      throw error;
    }
  }

  private rememberOutcome(key: string, outcome: Outcome): void {
    this.recent.set(key, outcome);
    if (this.recent.size > RECENT_OUTCOMES) this.recent.delete(this.recent.keys().next().value!);
  }

  private get(projectId: string): Promise<StoredProject> {
    let stored = this.cache.get(projectId);
    if (!stored) {
      stored = readProject(this.db, projectId);
      this.cache.set(projectId, stored);
      stored.catch(() => this.cache.delete(projectId));
    }
    return stored;
  }

  /** New assignees must be existing, active team members (keeping the current one is always fine). */
  private async checkReferences(stored: StoredProject, command: Command): Promise<void> {
    if (command.type !== "setAssignee" || command.resourceId === null) return;
    const row = stored.state.rows[command.id];
    if (row?.kind === "task" && row.resourceId === command.resourceId) return;
    const resource = await this.db.resource.findUnique({ where: { id: command.resourceId } });
    if (!resource) throw new HttpError(422, "invalid", "That team member does not exist");
    if (resource.inactive) throw new HttpError(422, "invalid", "That team member is inactive");
  }
}

/** Stable fingerprint of a request (JSON with sorted keys), so stored payloads compare regardless of key order. */
function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function notify<T>(listener: (value: T) => void, value: T): void {
  try {
    listener(value);
  } catch {
    // A failing listener must not affect a committed change.
  }
}

/** Persists the rows touched by `changes` using their final values in `state` (deletes/creates batched). */
async function writeRows(tx: Tx, projectId: string, state: ProjectState, changes: readonly RowChange[]): Promise<void> {
  const created = new Set(changes.filter((change) => change.field === "*" && change.before === null).map((change) => change.rowId));
  const deleted: string[] = [];
  const inserted: Prisma.RowCreateManyInput[] = [];
  const updated: Row[] = [];
  for (const rowId of new Set(changes.map((change) => change.rowId))) {
    const row = state.rows[rowId];
    if (!row) deleted.push(rowId);
    else if (created.has(rowId)) inserted.push({ ...toDbColumns(row), projectId });
    else updated.push(row);
  }
  if (deleted.length > 0) await tx.row.deleteMany({ where: { projectId, id: { in: deleted } } });
  if (inserted.length > 0) await tx.row.createMany({ data: inserted });
  for (const row of updated) {
    const { id, ...columns } = toDbColumns(row);
    await tx.row.updateMany({ where: { id, projectId }, data: columns });
  }
}
