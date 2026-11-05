import { useCriticalPathView } from "./critical-path-view";
import { applyCommand, type Calendar, type Command, type ProjectState } from "@ganttlines/engine";
import type { ResourceDto } from "@ganttlines/protocol";
import { createContext, useContext } from "react";
import type { BoardSync } from "../sync/board-sync";
import { toast } from "../ui/toast";
import { replay } from "./pending";

export interface BoardContextValue {
  sync: BoardSync;
  calendar: Calendar;
  /** confirmed rows + own pending edits */
  state: ProjectState;
  resources: readonly ResourceDto[];
  resourceMap: ReadonlyMap<string, ResourceDto>;
  /** whether this person may change the board right now (role, archive, baseline view, connection) */
  canEdit: boolean;
  /** may add team members from the assignee picker */
  canCreateResources: boolean;
  /** may write comments (members; everyone on a collaborative share link) */
  canComment: boolean;
  /** may add holidays and time off (signed-in editors and admins, not share-link visitors) */
  canEditCalendar: boolean;
}

export const BoardContext = createContext<BoardContextValue | null>(null);

export function useBoard(): BoardContextValue {
  const value = useContext(BoardContext);
  if (!value) throw new Error("useBoard outside a board");
  return value;
}

/**
 * Checks an edit against the latest rows (confirmed + pending, read fresh so several edits in one
 * event see each other) and submits it. A refused edit shows the engine's reason and is not sent.
 * Returns the resulting rows, or null when refused.
 */
export function runCommand(board: Pick<BoardContextValue, "sync" | "calendar" | "canEdit">, command: Command): ProjectState | null {
  if (!board.canEdit) return null;
  const { confirmed, pending } = board.sync.state;
  const before = replay(confirmed, pending, board.calendar);
  const result = applyCommand(before, board.calendar, command);
  if (!result.ok) {
    toast(result.message, { tone: "error" });
    return null;
  }
  board.sync.submit(command);
  // Your own new aim is what you'd want to see the effect of; someone else's doesn't change your view.
  if (startsAnAim(before, command)) {
    useCriticalPathView.getState().set(board.sync.projectId, true);
  }
  return result.state;
}

/** A task that wasn't aiming for anything now is: changing what it aims for doesn't count. */
function startsAnAim(state: ProjectState, command: Command): boolean {
  if (command.type === "relink") return command.steps.some((step) => startsAnAim(state, step));
  if (command.type !== "createTargetMilestone" && (command.type !== "setTarget" || command.targetId === null)) return false;
  const row = state.rows[command.id];
  return row?.kind === "task" && (row.targetId ?? null) === null;
}

export function useRun(): (command: Command) => ProjectState | null {
  const board = useBoard();
  return (command) => runCommand(board, command);
}
