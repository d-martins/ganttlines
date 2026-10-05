import { useMemo } from "react";
import { create } from "zustand";
import { readPref, writePref } from "../storage";

const isIdList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const prefKey = (projectId: string) => `collapsed:${projectId}`;

interface Collapse {
  /** collapsed row ids per project, once read from (or written to) this browser's storage */
  byProject: Record<string, readonly string[]>;
  set: (projectId: string, ids: Iterable<string>, collapsed: boolean) => void;
  /** Forgets rows that no longer exist (deleted since they were collapsed). */
  prune: (projectId: string, exists: (id: string) => boolean) => void;
}

const stored = (state: Collapse, projectId: string) => state.byProject[projectId] ?? readPref(prefKey(projectId), [], isIdList);

/**
 * Which rows are collapsed is a way of looking at the board, not a change to it: it is kept per
 * browser and per project, never sent to the server, and works for viewers too.
 */
export const useCollapse = create<Collapse>((set) => ({
  byProject: {},
  set: (projectId, ids, collapsed) =>
    set((state) => {
      const next = new Set(stored(state, projectId));
      for (const id of ids) {
        if (collapsed) next.add(id);
        else next.delete(id);
      }
      const list = [...next];
      writePref(prefKey(projectId), list);
      return { byProject: { ...state.byProject, [projectId]: list } };
    }),
  prune: (projectId, exists) =>
    set((state) => {
      const current = stored(state, projectId);
      const kept = current.filter(exists);
      if (kept.length === current.length) return state;
      writePref(prefKey(projectId), kept);
      return { byProject: { ...state.byProject, [projectId]: kept } };
    }),
}));

/** The collapsed rows of a project, as a set. */
export function useCollapsed(projectId: string): ReadonlySet<string> {
  const list = useCollapse((state) => state.byProject[projectId]);
  return useMemo(() => new Set(list ?? readPref(prefKey(projectId), [], isIdList)), [list, projectId]);
}

export const setCollapsed = (projectId: string, ids: Iterable<string>, collapsed: boolean) => useCollapse.getState().set(projectId, ids, collapsed);
