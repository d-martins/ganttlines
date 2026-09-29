import { buildTree, childrenOf, fromDay, type ProjectState, type Row, type RowId, type Span, type TaskRow } from "@ganttlines/engine";
import { toast } from "../../ui/toast";
import { runCommand, type BoardContextValue } from "../board-context";
import { setCollapsed } from "../collapse";
import { useSelection } from "../selection";

type Board = Pick<BoardContextValue, "sync" | "calendar" | "canEdit">;

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
  if (!runCommand(board, { type: "deleteRows", ids: [row.id] })) return;
  const selection = useSelection.getState();
  if (selection.selectedId === row.id) selection.select(null);
  toast(`Deleted “${row.title || "Untitled"}”`, { action: { label: "Undo", run: () => board.sync.requestHistory("undo") } });
}

/** "#3", "3", "#3 +2", "#3 -1", "#3 −1" → row number and offset; "" → none; null when unreadable. */
export function parsePredecessor(text: string): { number: number; offset: number } | "none" | null {
  const trimmed = text.trim();
  if (trimmed === "") return "none";
  const match = /^#?\s*(\d+)\s*(?:([+\-−])\s*(\d+))?$/.exec(trimmed);
  if (!match) return null;
  const offset = match[3] ? Number(match[3]) * (match[2] === "+" ? 1 : -1) : 0;
  return { number: Number(match[1]), offset };
}

/**
 * Sets a task's predecessor from what was typed in the list. The engine makes the earlier-starting
 * task the predecessor, so linking to a row that starts later reverses the link (explained in a toast).
 */
export function setPredecessor(board: Board, state: ProjectState, task: TaskRow, text: string, numbers: ReadonlyMap<RowId, number>): void {
  const parsed = parsePredecessor(text);
  if (parsed === null) return toast("Type a row number, optionally with an offset: #3, #3 +2 or #3 -1", { tone: "error" });
  if (parsed === "none") {
    if (task.predecessorId) runCommand(board, { type: "removePredecessor", id: task.id });
    return;
  }
  const predecessorId = [...numbers].find(([, number]) => number === parsed.number)?.[0];
  const predecessor = predecessorId ? state.rows[predecessorId] : undefined;
  if (!predecessor) return toast(`There is no row #${parsed.number}`, { tone: "error" });
  if (predecessor.kind !== "task") return toast(`Row #${parsed.number} is a section; only tasks can be predecessors`, { tone: "error" });

  if (task.predecessorId === predecessor.id) {
    if (parsed.offset !== task.offset) runCommand(board, { type: "setOffset", id: task.id, offset: parsed.offset });
    return;
  }
  const linked = runCommand(board, { type: "linkTasks", fromId: predecessor.id, toId: task.id });
  if (!linked) return;
  // Linking starts at offset 0; apply the typed offset to whichever task became the successor.
  const reversed = (linked.rows[task.id] as TaskRow).predecessorId !== predecessor.id;
  if (reversed) toast(`Row #${parsed.number} starts later, so it now follows this task instead`);
  if (parsed.offset !== 0) runCommand(board, { type: "setOffset", id: reversed ? predecessor.id : task.id, offset: parsed.offset });
}

/** Sets working days from the WD column: 0 makes a milestone. */
export function setWorkingDays(board: Board, task: TaskRow, value: number): void {
  if (!Number.isInteger(value) || value < 0) return toast("Working days must be a whole number (0 = milestone)", { tone: "error" });
  if (value === task.duration) return;
  if (value === 0) {
    runCommand(board, { type: "convertMilestone", id: task.id, milestone: true });
    return;
  }
  if (task.duration === 0 && !runCommand(board, { type: "convertMilestone", id: task.id, milestone: false })) return;
  if (value !== 1 || task.duration !== 0) runCommand(board, { type: "setDuration", id: task.id, duration: value });
}

/**
 * Sets calendar days from the CD column: the task keeps its start and ends that many days later
 * (on the last working day by then); its working days follow from the calendar.
 */
export function setCalendarDays(board: Board, task: TaskRow, span: Span, value: number): void {
  if (!Number.isInteger(value) || value < 1) return toast("Calendar days must be a whole number from 1", { tone: "error" });
  runCommand(board, { type: "resizeTask", id: task.id, edge: "end", date: fromDay(span.start + value - 1) });
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
