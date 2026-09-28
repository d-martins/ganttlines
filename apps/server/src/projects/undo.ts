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
 * made since by anyone are never overwritten (skip-on-conflict, spec §5.4). Whole rows are
 * removed only if unchanged and nothing points to them, and re-created only if absent.
 */
export function revertChanges(state: ProjectState, changes: readonly RowChange[], direction: "undo" | "redo"): Reverted {
  const rows: Record<RowId, Row> = { ...state.rows };
  const ordered = direction === "undo" ? [...changes].reverse() : changes;
  let skipped = 0;
  for (const change of ordered) {
    const expected = direction === "undo" ? change.after : change.before;
    const target = direction === "undo" ? change.before : change.after;
    const current = rows[change.rowId];
    if (change.field === "*") {
      if (target === null) {
        if (current && isDeepStrictEqual(current, expected) && !isReferenced(rows, change.rowId)) delete rows[change.rowId];
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
  return { state: { rows }, skipped };
}

function isReferenced(rows: Readonly<Record<RowId, Row>>, id: RowId): boolean {
  return Object.values(rows).some((row) => row.parentId === id || (row.kind === "task" && row.predecessorId === id));
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

  popUndo(projectId: string, userId: string): string | undefined {
    return this.get(projectId, userId).undo.pop();
  }

  popRedo(projectId: string, userId: string): string | undefined {
    return this.get(projectId, userId).redo.pop();
  }

  pushUndone(projectId: string, userId: string, commandId: string): void {
    this.get(projectId, userId).redo.push(commandId);
  }

  pushRedone(projectId: string, userId: string, commandId: string): void {
    this.get(projectId, userId).undo.push(commandId);
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
