import type { ProjectState, Row, RowChange, RowId } from "@ganttlines/engine";
import { isDeepStrictEqual } from "node:util";

export interface Reverted {
  state: ProjectState;
  /** changes that could not be reverted because the value was changed by someone since */
  skipped: number;
}

/**
 * Undo (`direction: "undo"`) restores each change's `before` value; redo restores `after`.
 * A field is only restored while it still holds the value this command left behind, so edits
 * made since by anyone are never overwritten (skip-on-conflict). Whole rows are
 * removed only if unchanged and nothing points to them, and re-created only if absent.
 */
export function revertChanges(state: ProjectState, changes: readonly RowChange[], direction: "undo" | "redo"): Reverted {
  const rows: Record<RowId, Row> = { ...state.rows };
  const ordered = direction === "undo" ? [...changes].reverse() : changes;
  const removals = new Set<RowId>();
  let skipped = 0;
  for (const change of ordered) {
    const expected = direction === "undo" ? change.after : change.before;
    const target = direction === "undo" ? change.before : change.after;
    const current = rows[change.rowId];
    if (change.field === "*") {
      if (target === null) {
        // Removed together at the end, so a parent and its children (or a predecessor and the
        // successor detached by the same command) are handled as one set, whatever their order.
        if (current && isDeepStrictEqual(current, expected)) removals.add(change.rowId);
        else skipped++;
      } else if (!current) {
        rows[change.rowId] = target as Row;
      } else {
        skipped++;
      }
      continue;
    }
    const value = current ? (current as unknown as Record<string, unknown>)[change.field] : undefined;
    if (current && isDeepStrictEqual(value, expected)) rows[change.rowId] = { ...current, [change.field]: target } as Row;
    else skipped++;
  }
  skipped += removeUnreferenced(rows, removals);
  return { state: { rows }, skipped };
}

/**
 * Deletes the `candidates` that no remaining row points to (as parent or predecessor). A candidate
 * that is still referenced from outside the set is kept — and so are the candidates it points to.
 * Returns how many candidates had to be kept.
 */
function removeUnreferenced(rows: Record<RowId, Row>, candidates: Set<RowId>): number {
  const initial = candidates.size;
  for (let changed = true; changed; ) {
    changed = false;
    const referenced = new Set<RowId>();
    for (const row of Object.values(rows)) {
      if (candidates.has(row.id)) continue;
      if (row.parentId !== null) referenced.add(row.parentId);
      if (row.kind === "task" && row.predecessorId !== null) referenced.add(row.predecessorId);
    }
    for (const id of candidates) {
      if (referenced.has(id)) {
        candidates.delete(id);
        changed = true;
      }
    }
  }
  for (const id of candidates) delete rows[id];
  return initial - candidates.size;
}

/** Bounded per-user, per-project undo/redo history of command ids. */
export class UndoStacks {
  private readonly stacks = new Map<string, { undo: string[]; redo: string[] }>();

  constructor(private readonly limit = 100) {}

  /** A new command: it becomes undoable and clears the redo history. */
  pushCommand(projectId: string, userId: string, commandId: string): void {
    const stack = this.get(projectId, userId);
    stack.undo.push(commandId);
    if (stack.undo.length > this.limit) stack.undo.shift();
    stack.redo = [];
  }

  peek(direction: "undo" | "redo", projectId: string, userId: string): string | undefined {
    return this.get(projectId, userId)[direction].at(-1);
  }

  pop(direction: "undo" | "redo", projectId: string, userId: string): string | undefined {
    return this.get(projectId, userId)[direction].pop();
  }

  popUndo(projectId: string, userId: string): string | undefined {
    return this.pop("undo", projectId, userId);
  }

  popRedo(projectId: string, userId: string): string | undefined {
    return this.pop("redo", projectId, userId);
  }

  pushUndone(projectId: string, userId: string, commandId: string): void {
    this.get(projectId, userId).redo.push(commandId);
  }

  pushRedone(projectId: string, userId: string, commandId: string): void {
    this.get(projectId, userId).undo.push(commandId);
  }

  /** Drops every stack of a (deleted) project. */
  forgetProject(projectId: string): void {
    for (const key of this.stacks.keys()) if (key.startsWith(`${projectId}:`)) this.stacks.delete(key);
  }

  private get(projectId: string, userId: string) {
    const key = `${projectId}:${userId}`;
    let stack = this.stacks.get(key);
    if (!stack) {
      stack = { undo: [], redo: [] };
      this.stacks.set(key, stack);
    }
    return stack;
  }
}
