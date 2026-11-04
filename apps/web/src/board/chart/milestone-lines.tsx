import type { DayNum, ProjectState, RowId } from "@ganttlines/engine";
import type { BoardRow } from "../model";
import type { Timeline } from "./timeline";

export interface AimedMilestone {
  id: RowId;
  title: string;
  day: DayNum;
}

/** The dated milestones at least one task aims for. */
export function aimedMilestones(state: ProjectState, rows: readonly BoardRow[]): AimedMilestone[] {
  const aimed = new Set(Object.values(state.rows).flatMap((row) => (row.kind === "task" && row.targetId ? [row.targetId] : [])));
  return rows.flatMap((entry) => (aimed.has(entry.row.id) && entry.span ? [{ id: entry.row.id, title: entry.row.title || "Untitled", day: entry.span.start }] : []));
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
