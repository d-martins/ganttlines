import { create } from "zustand";
import type { BoardSync } from "../sync/board-sync";

/**
 * The board on screen, so the top bar can show its tools, connection state and viewers.
 * `canManage`: may share it and save/delete baselines (signed-in editors and admins, not in link mode).
 */
export const useActiveBoard = create<{ sync: BoardSync | null; canEdit: boolean; canManage: boolean }>(() => ({ sync: null, canEdit: false, canManage: false }));
