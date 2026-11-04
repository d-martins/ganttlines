import { create } from "zustand";
import { readPref, writePref } from "../storage";

const KEY = "criticalPath";
const isChoices = (value: unknown): value is Record<string, boolean> => typeof value === "object" && value !== null && !Array.isArray(value);

interface CriticalPathView {
  on: Record<string, boolean>;
  toggle: (projectId: string) => void;
}

/** Whether a board shows what can slip: view state, remembered per browser for each project; never an edit. */
export const useCriticalPathView = create<CriticalPathView>((set, get) => ({
  on: readPref(KEY, {}, isChoices),
  toggle: (projectId) => {
    const { [projectId]: was, ...others } = get().on;
    const on = was ? others : { ...others, [projectId]: true };
    writePref(KEY, on);
    set({ on });
  },
}));

export const useCriticalPath = (projectId: string): boolean => useCriticalPathView((view) => view.on[projectId] === true);
export const isCriticalPathOn = (projectId: string): boolean => useCriticalPathView.getState().on[projectId] === true;
