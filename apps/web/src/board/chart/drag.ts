import { fromDay, type Command, type DayNum, type RowId, type Span } from "@ganttlines/engine";
import { create } from "zustand";
import type { Timeline } from "./timeline";

export type DragKind = "move" | "start" | "end" | "link";

/** A drag in progress on the chart; the board previews `command` through the engine. */
export interface ChartDrag {
  rowId: RowId;
  kind: DragKind;
  /** what dropping now would send (null: nothing would change) */
  command: Command | null;
  /** link drags: the line from the bullet to the pointer, in chart coordinates */
  line: { x1: number; y1: number; x2: number; y2: number } | null;
  /** link drags: the task under the pointer that would be linked */
  targetId: RowId | null;
}

export const useChartDrag = create<{ drag: ChartDrag | null }>(() => ({ drag: null }));

/**
 * The command a move/resize drag stands for, given how far the pointer travelled (`dx` pixels) or
 * where it is (`x`). Days snap to visible columns, so hidden weekends are skipped. Null when the
 * task would stay as it is.
 */
export function dragCommand(kind: Exclude<DragKind, "link">, rowId: RowId, span: Span, timeline: Timeline, dx: number, x: number): Command | null {
  if (kind === "move") {
    // The bar's new left edge, rounded to the nearest column.
    const start = timeline.dayAt(timeline.x(span.start) + dx + timeline.dayWidth / 2);
    return start === span.start ? null : { type: "moveTask", id: rowId, start: fromDay(start) };
  }
  const day = timeline.dayAt(x);
  if (kind === "end") return day === span.end ? null : { type: "resizeTask", id: rowId, edge: "end", date: fromDay(Math.max(day, span.start)) };
  return day === span.start ? null : { type: "resizeTask", id: rowId, edge: "start", date: fromDay(Math.min(day, span.end)) };
}

/** The visible day `steps` columns away from `day` (keyboard moves skip hidden weekends too). */
export function stepDay(timeline: Timeline, day: DayNum, steps: number): DayNum {
  return timeline.dayAt(timeline.x(day) + steps * timeline.dayWidth + timeline.dayWidth / 2);
}
