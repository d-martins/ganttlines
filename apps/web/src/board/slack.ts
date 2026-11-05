import { analyseSlack, buildTree, childrenOf, computeSchedule, CycleError, isParentTask, type Calendar, type LinkKey, type ProjectState, type RowId, type Schedule, type SlackAnalysis } from "@ganttlines/engine";
import { useBoard } from "./board-context";
import { useCriticalPath } from "./critical-path-view";

/** "4 days", "1 day", "0 days", "−1 day", "1.5 days". */
export function formatSlack(halves: number): string {
  const days = Math.abs(halves) / 2;
  return `${halves < 0 ? "\u2212" : ""}${days} ${days === 1 ? "day" : "days"}`;
}

const NOTHING: SlackAnalysis = { slack: new Map(), critical: new Set(), pastTarget: new Set() };

/** Worked out once per version of the board, however many parts of the page ask. */
const analyses = new WeakMap<ProjectState, { calendar: Calendar; schedule: Schedule | null; analysis?: SlackAnalysis }>();

function analysed(state: ProjectState, calendar: Calendar) {
  let entry = analyses.get(state);
  if (!entry || entry.calendar !== calendar) {
    let schedule: Schedule | null = null;
    try {
      schedule = computeSchedule(state, calendar);
    } catch (error) {
      if (!(error instanceof CycleError)) throw error;
    }
    entry = { calendar, schedule };
    analyses.set(state, entry);
  }
  return entry;
}

/** The board's dates, shared with the slack worked out from them. */
export function boardSchedule(state: ProjectState, calendar: Calendar): Schedule | null {
  return analysed(state, calendar).schedule;
}

function slackAnalysis(state: ProjectState, calendar: Calendar): SlackAnalysis {
  const entry = analysed(state, calendar);
  if (!entry.schedule) return NOTHING;
  entry.analysis ??= analyseSlack(state, calendar, entry.schedule);
  return entry.analysis;
}

const hasTargets = (state: ProjectState) => Object.values(state.rows).some((row) => row.kind === "task" && row.targetId);

/** How far tasks can slip. A board nobody aims on pays nothing for this until Critical path is on. */
export function useSlackAnalysis(): SlackAnalysis {
  const { state, calendar, sync } = useBoard();
  const on = useCriticalPath(sync.projectId);
  return on || hasTargets(state) ? slackAnalysis(state, calendar) : NOTHING;
}

/** The links a slip passes straight through, while the Critical path button is on. */
export function useCriticalLinks(): ReadonlySet<LinkKey> {
  const { state, calendar, sync } = useBoard();
  const on = useCriticalPath(sync.projectId);
  return on ? slackAnalysis(state, calendar).critical : NOTHING.critical;
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
