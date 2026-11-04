import type { DayNum, ProjectState, RowId, Schedule } from "@ganttlines/engine";
import type { BoardRow } from "../model";
import type { Timeline } from "./timeline";

export interface AimedMilestone {
  id: RowId;
  title: string;
  day: DayNum;
}

/**
 * The dated milestones at least one task aims for, whether or not their own rows are on screen (collapsed,
 * filtered out). `rows` are the rows on screen: their dates win, as they may be a baseline's.
 */
export function aimedMilestones(state: ProjectState, schedule: Schedule | null, rows: readonly BoardRow[]): AimedMilestone[] {
  const aimed = new Set(Object.values(state.rows).flatMap((row) => (row.kind === "task" && row.targetId ? [row.targetId] : [])));
  const shown = new Map(rows.map((entry) => [entry.row.id, entry.span]));
  return [...aimed].flatMap((id) => {
    const span = shown.has(id) ? shown.get(id) : schedule?.get(id)?.span;
    const row = state.rows[id];
    return row && span ? [{ id, title: row.title || "Untitled", day: span.start }] : [];
  });
}

/** A dashed line down the chart for each. */
export function MilestoneLines({ milestones, timeline, height }: { milestones: readonly AimedMilestone[]; timeline: Timeline; height: number }) {
  return milestones.map((milestone) => (
    <div
      key={milestone.id}
      aria-hidden
      data-testid="milestone-line"
      className="pointer-events-none absolute top-0 w-0 border-l-2 border-dashed border-[var(--target-line)]"
      style={{ left: timeline.x(milestone.day) + timeline.dayWidth / 2 - 1, height }}
    />
  ));
}
