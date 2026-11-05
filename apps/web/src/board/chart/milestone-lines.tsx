import type { DayNum, ProjectState, RowId, Schedule } from "@ganttlines/engine";
import { create } from "zustand";
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
export function aimedMilestones(state: ProjectState, scheduleOf: () => Schedule | null, rows: readonly BoardRow[]): AimedMilestone[] {
  const aimed = new Set(Object.values(state.rows).flatMap((row) => (row.kind === "task" && row.targetId ? [row.targetId] : [])));
  if (aimed.size === 0) return [];
  const schedule = scheduleOf();
  const shown = new Map(rows.map((entry) => [entry.row.id, entry.span]));
  return [...aimed].flatMap((id) => {
    const span = shown.has(id) ? shown.get(id) : schedule?.get(id)?.span;
    const row = state.rows[id];
    return row && span ? [{ id, title: row.title || "Untitled", day: span.start }] : [];
  });
}

/** The milestone whose line stands out: the one limiting the "Can slip" value under the pointer. */
export const useHoveredMilestone = create<{ id: RowId | null }>(() => ({ id: null }));

/** A dashed line down the chart for each. */
export function MilestoneLines({ milestones, timeline, height }: { milestones: readonly AimedMilestone[]; timeline: Timeline; height: number }) {
  const hovered = useHoveredMilestone((state) => state.id);
  return milestones.map((milestone) => (
    <div
      key={milestone.id}
      aria-hidden
      data-testid="milestone-line"
      data-hovered={hovered === milestone.id || undefined}
      className={`pointer-events-none absolute top-0 w-0 border-[var(--target-line)] ${hovered === milestone.id ? "border-l-[3px] border-solid" : "border-l-2 border-dashed"}`}
      style={{ left: timeline.x(milestone.day) + timeline.dayWidth / 2 - 1, height }}
    />
  ));
}
