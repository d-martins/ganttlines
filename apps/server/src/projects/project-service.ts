import { Prisma, toDbColumns, type Db, type Project } from "@ganttlines/db";
import { applyCommand, type Command, type ProjectState, type Row, type RowChange } from "@ganttlines/engine";
import type { ChangesDto, CommandResultDto, ProjectStateDto } from "@ganttlines/protocol";
import { isDeepStrictEqual } from "node:util";
import type { Actor } from "../actor";
import type { InstanceService } from "../calendar/instance-service";
import { toProjectDto } from "../dto";
import { conflict, HttpError } from "../errors";
import { KeyedQueue } from "../queue";
import { readProject, type StoredProject } from "./state";

/** Clients further behind than this reload the whole project instead of replaying changes. */
export const MAX_CATCH_UP = 500;
/** Large commands (e.g. deleting thousands of rows) must not hit Prisma's 5 s default. */
const TRANSACTION_TIMEOUT_MS = 30_000;

type Tx = Prisma.TransactionClient;

/**
 * Authoritative project state: an in-memory copy per project (loaded on first use) that every
 * command goes through, one command at a time per project. Each applied command is persisted
 * together with its command-log entry and a version bump in a single transaction.
 */
export class ProjectService {
  private readonly cache = new Map<string, Promise<StoredProject>>();
  private readonly queue = new KeyedQueue();

  constructor(
    private readonly db: Db,
    private readonly instance: InstanceService,
  ) {}

  async state(projectId: string): Promise<ProjectStateDto> {
    return this.queue.run(projectId, async () => {
      const { meta, state } = await this.get(projectId);
      return { project: toProjectDto(meta), rows: Object.values(state.rows) };
    });
  }

  /** Applies a command. Retrying with the same `commandId` returns the original result. */
  apply(projectId: string, actor: Actor, commandId: string, command: Command): Promise<CommandResultDto> {
    return this.queue.run(projectId, async () => {
      try {
        return await this.applyNow(projectId, actor, commandId, command);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        // Unexpected failure: the cached copy may no longer match the database, so drop it and
        // let the next request reload. A version mismatch means the database moved on without us.
        this.cache.delete(projectId);
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
          throw conflict("The project changed on the server; please retry");
        }
        throw error;
      }
    });
  }

  private async applyNow(projectId: string, actor: Actor, commandId: string, command: Command): Promise<CommandResultDto> {
    const stored = await this.get(projectId);
    const logged = await this.db.commandLog.findUnique({ where: { commandId } });
    if (logged) {
      const sameCommand = logged.projectId === projectId && isDeepStrictEqual(logged.payload, JSON.parse(JSON.stringify(command)));
      if (!sameCommand) throw conflict("This commandId was already used for something else");
      return { version: logged.version, changes: logged.changes as unknown as RowChange[] };
    }
    if (stored.meta.archivedAt) throw conflict("This project is archived");
    await this.checkReferences(stored, command);

    const result = applyCommand(stored.state, (await this.instance.current()).calendar, command);
    if (!result.ok) throw new HttpError(422, result.reason, result.message);
    if (result.changes.length === 0) return { version: stored.meta.version, changes: [] };

    const version = stored.meta.version + 1;
    const meta = await this.db.$transaction(async (tx) => {
      await writeRows(tx, projectId, result.state, result.changes);
      await tx.commandLog.create({
        data: {
          projectId,
          version,
          commandId,
          actorUserId: actor.userId,
          actorLabel: actor.label,
          name: command.type,
          payload: command as unknown as Prisma.InputJsonValue,
          changes: result.changes as unknown as Prisma.InputJsonValue,
        },
      });
      return tx.project.update({ where: { id: projectId, version: stored.meta.version }, data: { version } });
    }, { timeout: TRANSACTION_TIMEOUT_MS });
    stored.meta = meta;
    stored.state = result.state;
    return { version, changes: result.changes };
  }

  /** Command-log entries after `since`, or "reload" when the client is too far behind. */
  changesSince(projectId: string, since: number): Promise<ChangesDto> {
    return this.queue.run(projectId, async () => {
      const { version } = (await this.get(projectId)).meta;
      // Too far behind — or ahead (e.g. after a database restore): start again from /state.
      if (version - since > MAX_CATCH_UP || since > version) return { version, reload: true };
      const entries = await this.db.commandLog.findMany({
        where: { projectId, version: { gt: since } },
        orderBy: { version: "asc" },
      });
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
      return stored.meta;
    });
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
