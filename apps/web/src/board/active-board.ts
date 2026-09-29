import { create } from "zustand";
import type { BoardSync } from "../sync/board-sync";

/** The board on screen, so the top bar can show its tools, connection state and viewers. */
export const useActiveBoard = create<{ sync: BoardSync | null; canEdit: boolean }>(() => ({ sync: null, canEdit: false }));
