import { buildTree, childrenOf, computeSchedule, computeSlack, criticalLinks, CycleError, isParentTask, type LinkKey, type ProjectState, type RowId, type Schedule, type SlackMap } from "@ganttlines/engine";
import { useMemo } from "react";
import { useBoard } from "./board-context";
import { useCriticalPath } from "./critical-path-view";

const NO_SLACK: SlackMap = new Map();

/** "4 days", "1 day", "0 days", "−1 day", "1.5 days". */
export function formatSlack(halves: number): string {
  const days = Math.abs(halves) / 2;
  return `${halves < 0 ? "\u2212" : ""}${days} ${days === 1 ? "day" : "days"}`;
}

function scheduleOf(state: ProjectState, calendar: Parameters<typeof computeSchedule>[1]): Schedule | null {
  try {
    return computeSchedule(state, calendar);
  } catch (error) {
    if (error instanceof CycleError) return null;
    throw error;
  }
}

/** How far each task on the board can slip. */
export function useSlack(): SlackMap {
  const { state, calendar } = useBoard();
  return useMemo(() => {
    const schedule = scheduleOf(state, calendar);
    return schedule ? computeSlack(state, calendar, schedule) : NO_SLACK;
  }, [state, calendar]);
}

const NO_LINKS: ReadonlySet<LinkKey> = new Set();

/** The links a slip passes straight through, while the Critical path button is on. */
export function useCriticalLinks(): ReadonlySet<LinkKey> {
  const { state, calendar, sync } = useBoard();
  const slack = useSlack();
  const on = useCriticalPath(sync.projectId);
  return useMemo(() => {
    const schedule = on ? scheduleOf(state, calendar) : null;
    return schedule ? criticalLinks(state, calendar, schedule, slack) : NO_LINKS;
  }, [on, state, calendar, slack]);
}

/** Where a milestone made on the go lands: right after the last one being aimed at, else at the end of the board. */
export function newMilestonePlace(state: ProjectState): { parentId: RowId | null; afterId: RowId | null } {
  const tree = buildTree(state);
  const aimed = new Set(Object.values(state.rows).flatMap((row) => (row.kind === "task" && row.targetId ? [row.targetId] : [])));
  let last: { parentId: RowId | null; afterId: RowId } | null = null;
  const walk = (parentId: RowId | null) => {
    for (const row of childrenOf(tree, parentId)) {
      if (aimed.has(row.id)) last = { parentId, afterId: row.id };
      walk(row.id);
    }
  };
  walk(null);
  return last ?? { parentId: null, afterId: childrenOf(tree, null).at(-1)?.id ?? null };
}

/** The rows tasks can aim for: milestones, so no subtasks. */
export function milestonesOf(state: ProjectState) {
  const tree = buildTree(state);
  return Object.values(state.rows).filter((row) => row.kind === "task" && row.duration === 0 && !isParentTask(tree, row));
}
