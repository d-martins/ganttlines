import type { Db, Prisma } from "@ganttlines/db";

type Tx = Prisma.TransactionClient;

export type UndoDirection = "undo" | "redo";

/**
 * Per-actor, per-project undo/redo history of command ids (bounded). A store that `savesWithEdits`
 * takes the edit's transaction (`tx`), so the history and the board change together; otherwise
 * it's updated once the edit is saved.
 */
export interface UndoStore {
  readonly savesWithEdits: boolean;
  /** A new command: it becomes undoable and clears the redo history. */
  pushCommand(projectId: string, key: string, commandId: string, tx?: Tx): Promise<void>;
  peek(direction: UndoDirection, projectId: string, key: string): Promise<string | undefined>;
  pop(direction: UndoDirection, projectId: string, key: string, tx?: Tx): Promise<void>;
  pushUndone(projectId: string, key: string, commandId: string, tx?: Tx): Promise<void>;
  pushRedone(projectId: string, key: string, commandId: string, tx?: Tx): Promise<void>;
  forgetProject(projectId: string): Promise<void>;
}

/** One copy: in memory. */
export class MemoryUndoStore implements UndoStore {
  readonly savesWithEdits = false;
  private readonly stacks = new Map<string, { undo: string[]; redo: string[] }>();

  constructor(private readonly limit = 100) {}

  async pushCommand(projectId: string, key: string, commandId: string): Promise<void> {
    const stack = this.get(projectId, key);
    stack.undo.push(commandId);
    if (stack.undo.length > this.limit) stack.undo.shift();
    stack.redo = [];
  }

  async peek(direction: UndoDirection, projectId: string, key: string): Promise<string | undefined> {
    return this.get(projectId, key)[direction].at(-1);
  }

  async pop(direction: UndoDirection, projectId: string, key: string): Promise<void> {
    this.get(projectId, key)[direction].pop();
  }

  async pushUndone(projectId: string, key: string, commandId: string): Promise<void> {
    this.get(projectId, key).redo.push(commandId);
  }

  async pushRedone(projectId: string, key: string, commandId: string): Promise<void> {
    this.get(projectId, key).undo.push(commandId);
  }

  async forgetProject(projectId: string): Promise<void> {
    for (const key of this.stacks.keys()) if (key.startsWith(`${projectId}:`)) this.stacks.delete(key);
  }

  private get(projectId: string, key: string) {
    const id = `${projectId}:${key}`;
    let stack = this.stacks.get(id);
    if (!stack) {
      stack = { undo: [], redo: [] };
      this.stacks.set(id, stack);
    }
    return stack;
  }
}

/** Several copies: a table (callers hold the project's lock, so changes to one history don't race). */
export class PgUndoStore implements UndoStore {
  readonly savesWithEdits = true;

  constructor(
    private readonly db: Db,
    private readonly limit = 100,
  ) {}

  async pushCommand(projectId: string, key: string, commandId: string, tx?: Tx): Promise<void> {
    const push = async (tx: Tx) => {
      await tx.undoEntry.deleteMany({ where: { projectId, actorKey: key, kind: "redo" } });
      await tx.undoEntry.create({ data: { projectId, actorKey: key, kind: "undo", commandId } });
      const kept = await tx.undoEntry.findMany({ where: { projectId, actorKey: key, kind: "undo" }, orderBy: { id: "desc" }, take: this.limit, select: { id: true } });
      const oldest = kept.at(-1)?.id;
      if (kept.length === this.limit && oldest !== undefined) {
        await tx.undoEntry.deleteMany({ where: { projectId, actorKey: key, kind: "undo", id: { lt: oldest } } });
      }
    };
    await (tx ? push(tx) : this.db.$transaction(push));
  }

  async peek(direction: UndoDirection, projectId: string, key: string): Promise<string | undefined> {
    return (await this.db.undoEntry.findFirst({ where: { projectId, actorKey: key, kind: direction }, orderBy: { id: "desc" } }))?.commandId;
  }

  async pop(direction: UndoDirection, projectId: string, key: string, tx: Tx = this.db): Promise<void> {
    const top = await tx.undoEntry.findFirst({ where: { projectId, actorKey: key, kind: direction }, orderBy: { id: "desc" }, select: { id: true } });
    if (top) await tx.undoEntry.deleteMany({ where: { id: top.id } });
  }

  async pushUndone(projectId: string, key: string, commandId: string, tx: Tx = this.db): Promise<void> {
    await tx.undoEntry.create({ data: { projectId, actorKey: key, kind: "redo", commandId } });
  }

  async pushRedone(projectId: string, key: string, commandId: string, tx: Tx = this.db): Promise<void> {
    await tx.undoEntry.create({ data: { projectId, actorKey: key, kind: "undo", commandId } });
  }

  async forgetProject(): Promise<void> {
    // The rows go with the project (ON DELETE CASCADE).
  }
}
