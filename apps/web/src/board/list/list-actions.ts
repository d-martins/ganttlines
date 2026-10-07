import { buildTree, childrenOf, type ProjectState, type Row, type RowId, type TaskRow } from "@ganttlines/engine";
import { toast } from "../../ui/toast";
import { runCommand, type BoardContextValue } from "../board-context";
import { setCollapsed } from "../collapse";
import { useSelection } from "../selection";

type Board = Pick<BoardContextValue, "sync" | "calendar" | "canEdit" | "state">;

const newId = () => crypto.randomUUID();

/** Children of `parentId` in position order. */
function children(state: ProjectState, parentId: RowId | null): readonly Row[] {
  return childrenOf(buildTree(state), parentId);
}

/** Creates an untitled task and starts typing its title. */
function createAndEdit(board: Board, parentId: RowId | null, afterId: RowId | null, kind: Row["kind"] = "task", start?: string): RowId | null {
  const id = newId();
  if (!runCommand(board, { type: "createRow", id, kind, parentId, afterId, title: "", ...(start ? { start } : {}) })) return null;
  useSelection.getState().edit(id, true);
  return id;
}

/**
 * Enter on a row: a new task on the line below. Below an expanded section or parent that line is
 * its first child; otherwise it's the next sibling.
 */
export function addRowBelow(board: Board, state: ProjectState, row: Row, collapsed: boolean): RowId | null {
  const hasChildren = children(state, row.id).length > 0;
  if ((row.kind === "section" || hasChildren) && !collapsed) return createAndEdit(board, row.id, null);
  return createAndEdit(board, row.parentId, row.id, row.kind === "section" ? "section" : "task");
}

/** "+ subtask": a new last child (expanding the row first so it can be seen). */
export function addSubtask(board: Board, state: ProjectState, row: Row): RowId | null {
  setCollapsed(board.sync.projectId, [row.id], false);
  return createAndEdit(board, row.id, children(state, row.id).at(-1)?.id ?? null);
}

/** Footer "+ Add task" / "+ Add section" (or a click on the chart's blank row, with a start date): a new last top-level row. */
export function addAtEnd(board: Board, state: ProjectState, kind: Row["kind"], start?: string): RowId | null {
  return createAndEdit(board, null, children(state, null).at(-1)?.id ?? null, kind, start);
}

/** Deletes a row and everything inside it, with an Undo in the confirmation toast. */
export function deleteRow(board: Board, row: Row): void {
  // Everything inside goes too: say how much, so a big deletion isn't missed.
  const tree = buildTree(board.state);
  const countInside = (id: RowId): number => childrenOf(tree, id).reduce((sum, child) => sum + 1 + countInside(child.id), 0);
  const inside = countInside(row.id);
  if (!runCommand(board, { type: "deleteRows", ids: [row.id] })) return;
  const selection = useSelection.getState();
  if (selection.selectedId === row.id) selection.select(null);
  const extra = inside === 0 ? "" : ` and ${inside} ${inside === 1 ? "row" : "rows"} inside`;
  toast(`Deleted “${row.title || "Untitled"}”${extra}`, { action: { label: "Undo", run: () => board.sync.requestHistory("undo") } });
}

/**
 * Sets (or removes, with null) a task's predecessor. The engine makes the earlier-starting task
 * the predecessor, so picking one that starts later reverses the link (explained in a toast).
 * Offsets are never shown or typed: dragging a linked task records them.
 */
export function setPredecessor(board: Board, task: TaskRow, predecessorId: RowId | null, numbers: ReadonlyMap<RowId, number>): void {
  if (predecessorId === task.predecessorId) return;
  if (predecessorId === null) {
    runCommand(board, { type: "removePredecessor", id: task.id });
    return;
  }
  const linked = runCommand(board, { type: "linkTasks", fromId: predecessorId, toId: task.id });
  if (linked && (linked.rows[task.id] as TaskRow).predecessorId !== predecessorId) {
    toast(`Row #${numbers.get(predecessorId)} starts later, so it now follows this task instead`);
  }
}

/** "2.5" or "2,5" → 2.5; "" → null; NaN when unreadable. */
export function parseDays(text: string): number | null {
  const trimmed = text.trim().replace(",", ".");
  return trimmed === "" ? null : Number(trimmed);
}

const isHalfDays = (value: number) => Number.isFinite(value) && Number.isInteger(value * 2);

/** Sets working days from the WD column: whole or half days; 0 makes a milestone. */
export function setWorkingDays(board: Board, task: TaskRow, value: number): void {
  if (!isHalfDays(value) || value < 0) return toast("Working days are whole or half days, like 3 or 2.5 (0 = milestone)", { tone: "error" });
  if (value === task.duration) return;
  if (value === 0) {
    runCommand(board, { type: "convertMilestone", id: task.id, milestone: true });
    return;
  }
  if (task.duration === 0 && !runCommand(board, { type: "convertMilestone", id: task.id, milestone: false })) return;
  if (value !== 1 || task.duration !== 0) runCommand(board, { type: "setDuration", id: task.id, duration: value });
}

/** Records (or, with null, clears) the working days a task really took. */
export function setActualDays(board: Board, task: TaskRow, value: number | null): void {
  if (value !== null && (!isHalfDays(value) || value < 0.5)) return toast("Actual work days are whole or half days, like 5 or 2.5", { tone: "error" });
  if (value === task.actualDuration) return;
  runCommand(board, { type: "setActualDuration", id: task.id, days: value });
}

export type DropZone = "before" | "inside" | "after";

/** Where a dragged row lands relative to `target`, as a `moveRow`; null when that's not possible or changes nothing. */
export function dropMove(state: ProjectState, draggedId: RowId, target: Row, zone: DropZone): { parentId: RowId | null; afterId: RowId | null } | null {
  const dragged = state.rows[draggedId];
  if (!dragged || target.id === draggedId || isInside(state, target.id, draggedId)) return null;
  let move: { parentId: RowId | null; afterId: RowId | null };
  if (zone === "inside" && !(dragged.kind === "section" && target.kind === "task")) {
    const siblings = children(state, target.id).filter((row) => row.id !== draggedId);
    move = { parentId: target.id, afterId: siblings.at(-1)?.id ?? null };
  } else if (zone === "before") {
    const siblings = children(state, target.parentId).filter((row) => row.id !== draggedId);
    const index = siblings.findIndex((row) => row.id === target.id);
    move = { parentId: target.parentId, afterId: index > 0 ? siblings[index - 1]!.id : null };
  } else {
    move = { parentId: target.parentId, afterId: target.id };
  }
  if (dragged.kind === "section" && move.parentId !== null && state.rows[move.parentId]?.kind === "task") return null;
  // Already there?
  const current = children(state, dragged.parentId);
  const index = current.findIndex((row) => row.id === draggedId);
  if (move.parentId === dragged.parentId && move.afterId === (index > 0 ? current[index - 1]!.id : null)) return null;
  return move;
}

/** Whether `id` is `ancestorId` or somewhere below it. */
function isInside(state: ProjectState, id: RowId, ancestorId: RowId): boolean {
  let current: RowId | null = id;
  for (let steps = Object.keys(state.rows).length; current !== null && steps >= 0; steps--) {
    if (current === ancestorId) return true;
    current = state.rows[current]?.parentId ?? null;
  }
  return false;
}
