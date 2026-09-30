import { dayOf, fromDay, halfDay, isAfternoon, spanEnd, spanStart, type Command, type DayHalf, type DayNum, type HalfDay, type RowId, type Span } from "@ganttlines/engine";
import { create } from "zustand";
import { DAY_WIDTH, type Timeline } from "./timeline";

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

/** Drags and arrow keys work in half days where a day column is wide enough (day zoom); otherwise in whole days. */
export const snapsToHalves = (timeline: Timeline) => timeline.dayWidth >= DAY_WIDTH.day;

const halfName = (half: HalfDay): DayHalf => (isAfternoon(half) ? "afternoon" : "morning");

/** Where a task moved to `start` begins: `{ start, half }` for the command. */
export const startAt = (start: HalfDay) => ({ start: fromDay(dayOf(start)), half: halfName(start) });
/** The edge of a resize to half day `half`. */
export const edgeAt = (half: HalfDay) => ({ date: fromDay(dayOf(half)), half: halfName(half) });

/**
 * The command a move/resize drag stands for, given how far the pointer travelled (`dx` pixels) or
 * where it is (`x`). Snaps to visible columns (hidden weekends are skipped) — to half columns at day
 * zoom; at wider zooms a move keeps the half the task starts in. Null when the task would stay as it is.
 */
export function dragCommand(kind: Exclude<DragKind, "link">, rowId: RowId, span: Span, timeline: Timeline, dx: number, x: number): Command | null {
  const halves = snapsToHalves(timeline);
  const [from, to] = [spanStart(span), spanEnd(span)];
  if (kind === "move") {
    // The bar's new left edge, rounded to the nearest (half) column.
    const start = halves
      ? timeline.halfAt(timeline.xHalf(from) + dx + timeline.dayWidth / 4)
      : halfDay(timeline.dayAt(timeline.x(span.start) + dx + timeline.dayWidth / 2), span.startsAfternoon);
    return start === from ? null : { type: "moveTask", id: rowId, ...startAt(start) };
  }
  // Whole days: the end edge covers the whole day under the pointer, the start edge begins it.
  const at = halves ? timeline.halfAt(x) : halfDay(timeline.dayAt(x), kind === "end");
  if (kind === "end") {
    const end = Math.max(at, from);
    return end === to ? null : { type: "resizeTask", id: rowId, edge: "end", ...edgeAt(end) };
  }
  const start = Math.min(at, to);
  return start === from ? null : { type: "resizeTask", id: rowId, edge: "start", ...edgeAt(start) };
}

/** The visible day `steps` columns away from `day` (keyboard moves skip hidden weekends too). */
export function stepDay(timeline: Timeline, day: DayNum, steps: number): DayNum {
  return timeline.dayAt(timeline.x(day) + steps * timeline.dayWidth + timeline.dayWidth / 2);
}

/** One arrow-key step from `half`: half a column at day zoom, otherwise a column (keeping the half). */
export function stepHalf(timeline: Timeline, half: HalfDay, step: 1 | -1): HalfDay {
  const day = dayOf(half);
  if (!snapsToHalves(timeline)) return halfDay(stepDay(timeline, day, step), isAfternoon(half));
  if (step > 0) return isAfternoon(half) ? halfDay(stepDay(timeline, day, 1)) : half + 1;
  return isAfternoon(half) ? half - 1 : halfDay(stepDay(timeline, day, -1), true);
}
