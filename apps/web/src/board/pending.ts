import { applyCommand, type Calendar, type ProjectState } from "@ganttlines/engine";
import type { PendingCommand } from "../sync/board-sync";

/**
 * What the board shows: own pending commands replayed onto the server's rows through the same
 * engine the server runs, so edits appear at once and cascade exactly as they will there.
 * A pending command that no longer applies is skipped (the server will reject it too).
 */
export function replay(confirmed: ProjectState, pending: readonly PendingCommand[], calendar: Calendar): ProjectState {
  let state = confirmed;
  for (const { command } of pending) {
    const result = applyCommand(state, calendar, command);
    if (result.ok) state = result.state;
  }
  return state;
}
