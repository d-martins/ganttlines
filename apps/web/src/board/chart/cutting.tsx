import { dayOf, halfDay, spanEnd, spanStart, type Command, type HalfDay, type RowId, type Span } from "@ganttlines/engine";
import { useEffect, useRef } from "react";
import { create } from "zustand";
import type { BoardRow } from "../model";
import { ROW_HEIGHT } from "./bars";
import { edgeAt, snapsToHalves, useChartDrag } from "./drag";
import type { Timeline } from "./timeline";
import type { BarStyle } from "../view-store";

/** A bar being cut: first the line follows the pointer, then what's after the cut does. */
export const useCutting = create<{ rowId: RowId | null; line: HalfDay | null; cut: HalfDay | null }>(() => ({ rowId: null, line: null, cut: null }));

/** The first half to pause: inside a part, with at least half a day of the task before and after it. */
export function clampCut(at: HalfDay, parts: readonly Span[]): HalfDay {
  const first = spanStart(parts[0]!);
  const last = spanEnd(parts.at(-1)!);
  const clamped = Math.min(Math.max(at, first + 1), last);
  if (parts.some((part) => spanStart(part) <= clamped && clamped <= spanEnd(part))) return clamped;
  // In a gap: whichever side is closer.
  const before = Math.max(...parts.filter((part) => spanEnd(part) < clamped).map(spanEnd));
  const after = Math.min(...parts.filter((part) => spanStart(part) > clamped).map(spanStart));
  return clamped - before <= after - clamped ? before : after;
}

/** Where work picks up with the pointer at `at`: null when that wouldn't leave a gap. */
export const resumeAt = (at: HalfDay, cut: HalfDay): HalfDay | null => (at > cut ? at : null);

const breakCommand = (id: RowId, cut: HalfDay, resume: HalfDay): Command => {
  const [from, back] = [edgeAt(cut), edgeAt(resume)];
  return { type: "addBreak", id, from: from.date, fromHalf: from.half, resume: back.date, resumeHalf: back.half };
};

/** While a bar is being cut: follows the pointer, and takes every press so the board doesn't get it. */
export function Cutting({ rows, timeline, style, run }: { rows: readonly BoardRow[]; timeline: Timeline; style: BarStyle; run: (command: Command) => unknown }) {
  const { rowId, line, cut } = useCutting();
  const index = rowId === null ? -1 : rows.findIndex((entry) => entry.row.id === rowId);
  const parts = useRef<readonly Span[]>([]);
  const latest = useRef(timeline);
  latest.current = timeline;
  if (cut === null && index >= 0) parts.current = rows[index]!.parts;
  const shown = index >= 0;

  useEffect(() => {
    if (rowId === null) return;
    let endedByPress = false;
    const stop = () => {
      useChartDrag.setState({ drag: null });
      useCutting.setState({ rowId: null, line: null, cut: null });
    };
    const halfAtPointer = (event: PointerEvent): HalfDay => {
      const left = document.querySelector("[data-chart-body]")?.getBoundingClientRect().left ?? 0;
      const x = event.clientX - left;
      const now = latest.current;
      return snapsToHalves(now) ? now.halfAt(x) : halfDay(now.dayAt(x));
    };
    const commandAt = (event: PointerEvent, cutAt: HalfDay): Command | null => {
      const resume = resumeAt(halfAtPointer(event), cutAt);
      return resume === null ? null : breakCommand(rowId, cutAt, resume);
    };
    const move = (event: PointerEvent) => {
      const { cut: cutAt } = useCutting.getState();
      if (cutAt === null) useCutting.setState({ line: clampCut(halfAtPointer(event), parts.current) });
      else useChartDrag.setState({ drag: { rowId, command: commandAt(event, cutAt), line: null, targetId: null } });
    };
    const press = (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const { cut: cutAt } = useCutting.getState();
      if (cutAt === null) {
        useCutting.setState({ cut: clampCut(halfAtPointer(event), parts.current), line: null });
        return;
      }
      const command = commandAt(event, cutAt);
      endedByPress = true;
      stop();
      if (command) run(command);
    };
    const swallow = (event: Event) => event.stopPropagation();
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      stop();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerdown", press, true);
    window.addEventListener("click", swallow, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", press, true);
      window.removeEventListener("keydown", key, true);
      const release = () => window.removeEventListener("click", swallow, true);
      if (!endedByPress) return release();
      // The click that ends this press comes after the button is let go: it isn't for the board either.
      window.addEventListener("click", release, { capture: true, once: true });
      window.addEventListener("pointerup", () => setTimeout(release, 100), { capture: true, once: true });
    };
  }, [rowId !== null]);

  // The row went away (deleted, filtered out): nothing left to cut.
  useEffect(() => {
    if (rowId !== null && !shown) {
      useChartDrag.setState({ drag: null });
      useCutting.setState({ rowId: null, line: null, cut: null });
    }
  }, [rowId, shown]);
  useEffect(() => () => useCutting.setState({ rowId: null, line: null, cut: null }), []);

  if (!shown || line === null) return null;
  const rowHeight = ROW_HEIGHT[style];
  return (
    <div
      aria-hidden
      data-testid="cut-line"
      data-day={dayOf(line)}
      className="pointer-events-none absolute z-10 border-l-2 border-[var(--slack-zero)]"
      style={{ left: timeline.xHalf(line) - 1, top: index * rowHeight, height: rowHeight }}
    />
  );
}

/** Starts cutting `entry`, with the line where it first can be. */
export const startCutting = (entry: BoardRow) => {
  useCutting.setState({ rowId: entry.row.id, line: clampCut(spanStart(entry.parts[0]!), entry.parts), cut: null });
};
