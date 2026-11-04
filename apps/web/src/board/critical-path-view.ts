import { create } from "zustand";
import { readPref, writePref } from "../storage";

const KEY = "criticalPath";
const isChoices = (value: unknown): value is Record<string, boolean> => typeof value === "object" && value !== null && !Array.isArray(value);

interface CriticalPathView {
  /** the choice made for a project: remembered per browser; never an edit */
  on: Record<string, boolean>;
  /** with no choice made: settled once per project each time the app loads, from the board as it opened */
  defaults: Record<string, boolean>;
  set: (projectId: string, on: boolean) => void;
  toggle: (projectId: string) => void;
  /** Settles the default from whether the board has an aim. Later edits, by anyone, don't change it. */
  settleDefault: (projectId: string, hasAims: boolean) => void;
}

const isOn = ({ on, defaults }: Pick<CriticalPathView, "on" | "defaults">, projectId: string) => on[projectId] ?? defaults[projectId] ?? false;

/** Whether a board shows what can slip. */
export const useCriticalPathView = create<CriticalPathView>((set, get) => ({
  on: readPref(KEY, {}, isChoices),
  defaults: {},
  set: (projectId, value) => {
    const on = { ...get().on, [projectId]: value };
    writePref(KEY, on);
    set({ on });
  },
  toggle: (projectId) => get().set(projectId, !isOn(get(), projectId)),
  settleDefault: (projectId, hasAims) => {
    if (get().defaults[projectId] === undefined) set({ defaults: { ...get().defaults, [projectId]: hasAims } });
  },
}));

export const useCriticalPath = (projectId: string): boolean => useCriticalPathView((view) => isOn(view, projectId));
export const isCriticalPathOn = (projectId: string): boolean => isOn(useCriticalPathView.getState(), projectId);
