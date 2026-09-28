import { Prisma, toDbColumns, type Db, type Project } from "@ganttlines/db";
import { applyCommand, diffRows, hasCycle, type Command, type ProjectState, type Row, type RowChange } from "@ganttlines/engine";
import type { ChangesDto, CommandResultDto, ProjectDto, ProjectStateDto } from "@ganttlines/protocol";
import { isDeepStrictEqual } from "node:util";
import type { Actor } from "../actor";
import type { InstanceService } from "../calendar/instance-service";
import { toProjectDto } from "../dto";
import { conflict, HttpError } from "../errors";
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

type Outcome = { ok: true; result: CommandResultDto; payload: unknown } | { ok: false; error: HttpError; payload: unknown };

/**
 * Authoritative project state: an in-memory copy per project (loaded on first use) that every
 * command goes through, one command at a time per project. Each applied command is persisted
 * together with its command-log entry and a version bump in a single transaction, then announced
 * to listeners (the real-time hub) in version order.
 */
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
      const { meta, state } = await this.get(projectId);
      return { project: toProjectDto(meta), rows: Object.values(state.rows) };
    });
  }

  /** Applies a command. Retrying with the same `commandId` returns the original outcome. */
  apply(projectId: string, actor: Actor, commandId: string, command: Command): Promise<CommandResultDto> {
    return this.run(projectId, async (stored) => {
      const previous = await this.previousOutcome(projectId, commandId, command);
      if (previous) return previous;
      return this.remember(commandId, command, async () => {
        if (stored.meta.archivedAt) throw conflict("This project is archived");
        await this.checkReferences(stored, command);
        const result = applyCommand(stored.state, (await this.instance.current()).calendar, command);
        if (!result.ok) throw new HttpError(422, result.reason, result.message);
        if (result.changes.length === 0) return { version: stored.meta.version, changes: [] };
        const applied = await this.commit(stored, actor, commandId, command.type, command, result.state, result.changes);
        if (actor.userId) this.undoStacks.pushCommand(projectId, actor.userId, commandId);
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
      const { version } = (await this.get(projectId)).meta;
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
    return this.queue.run(projectId, async () => {
      const stored = await this.get(projectId);
      stored.meta = await this.db.project.update({ where: { id: projectId }, data });
      const dto = toProjectDto(stored.meta);
      for (const listener of this.metaListeners) notify(listener, dto);
      return stored.meta;
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
      if (!actor.userId) throw new HttpError(422, "invalid", "Undo needs a signed-in user");
      if (stored.meta.archivedAt) throw conflict("This project is archived");
      const target =
        direction === "undo" ? this.undoStacks.popUndo(projectId, actor.userId) : this.undoStacks.popRedo(projectId, actor.userId);
      if (!target) throw new HttpError(422, "invalid", direction === "undo" ? "Nothing to undo" : "Nothing to redo");
      const logged = await this.db.commandLog.findUnique({ where: { commandId: target } });
      if (!logged || logged.projectId !== projectId) throw new HttpError(422, "invalid", "That change is no longer available");

      const { state, skipped } = revertChanges(stored.state, logged.changes as unknown as RowChange[], direction);
      const problem = findTreeProblem(Object.values(state.rows));
      if (problem || hasCycle(state, (await this.instance.current()).calendar)) {
        throw new HttpError(409, "conflict", `Can't ${direction} this any more: the board changed since`);
      }
      const changes = diffRows(stored.state, state);
      if (changes.length === 0) throw new HttpError(409, "conflict", `Nothing left to ${direction}: it was all changed since`);
      const result = await this.commit(stored, actor, commandId, direction, { target }, state, changes);
      if (direction === "undo") this.undoStacks.pushUndone(projectId, actor.userId, target);
      else this.undoStacks.pushRedone(projectId, actor.userId, target);
      return { ...result, skipped };
    });
  }

  /** Runs `work` in the project's queue; unexpected failures drop the cached copy so the next request reloads. */
  private run<T>(projectId: string, work: (stored: StoredProject) => Promise<T>): Promise<T> {
    return this.queue.run(projectId, async () => {
      try {
        return await work(await this.get(projectId));
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
            name,
            payload: payload as Prisma.InputJsonValue,
            changes: changes as unknown as Prisma.InputJsonValue,
          },
        });
        return tx.project.update({ where: { id: projectId, version: stored.meta.version }, data: { version } });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    stored.meta = meta;
    stored.state = state;
    const event: AppliedEvent = { projectId, version, commandId, actor, changes };
    for (const listener of this.appliedListeners) notify(listener, event);
    return { version, changes };
  }

  /** The earlier outcome of this commandId (from the log, or from recent no-ops/rejections). */
  private async previousOutcome(projectId: string, commandId: string, command: Command): Promise<CommandResultDto | undefined> {
    const payload = JSON.parse(JSON.stringify(command)) as unknown;
    const recent = this.recent.get(commandId);
    if (recent) {
      if (!isDeepStrictEqual(recent.payload, payload)) throw conflict("This commandId was already used for something else");
      if (!recent.ok) throw recent.error;
      return recent.result;
    }
    const logged = await this.db.commandLog.findUnique({ where: { commandId } });
    if (!logged) return undefined;
    if (logged.projectId !== projectId || !isDeepStrictEqual(logged.payload, payload)) {
      throw conflict("This commandId was already used for something else");
    }
    return { version: logged.version, changes: logged.changes as unknown as RowChange[] };
  }

  /** Remembers no-op and rejected outcomes so a retried commandId gets the same answer. */
  private async remember(commandId: string, command: Command, work: () => Promise<CommandResultDto>): Promise<CommandResultDto> {
    const payload = JSON.parse(JSON.stringify(command)) as unknown;
    try {
      const result = await work();
      if (result.changes.length === 0) this.rememberOutcome(commandId, { ok: true, result, payload });
      return result;
    } catch (error) {
      if (error instanceof HttpError) this.rememberOutcome(commandId, { ok: false, error, payload });
      throw error;
    }
  }

  private rememberOutcome(commandId: string, outcome: Outcome): void {
    this.recent.set(commandId, outcome);
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
