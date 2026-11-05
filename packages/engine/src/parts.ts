import type { Calendar, ResourceId } from "./calendar";
import { halfDay, type HalfDay } from "./date";
import type { Break, Row, RowId } from "./model";
import { spanEnd, spanOfHalves, spanStart, type Computed, type Span } from "./schedule";

/** The stretches a scheduled row is worked: its parts when split, otherwise its whole span. */
export const partsOf = (computed: Computed | undefined): readonly Span[] => computed?.parts ?? (computed?.span ? [computed.span] : []);

/** Half days ranges merged and sorted, so a walk can pass them with a moving cursor. */
function mergedRanges(spans: readonly Span[]): { from: HalfDay; to: HalfDay }[] {
  const merged: { from: HalfDay; to: HalfDay }[] = [];
  for (const { from, to } of spans.map((span) => ({ from: spanStart(span), to: spanEnd(span) })).sort((a, b) => a.from - b.from)) {
    const last = merged.at(-1);
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else merged.push({ from, to });
  }
  return merged;
}

/**
 * Lays `halves` working half days out from `start`, pausing for `breaks` and wherever `busy` runs.
 * Walks half days, as busy time of any shape can land anywhere.
 */
export function layOutWork(calendar: Calendar, start: HalfDay, halves: number, breaks: readonly Break[], busy: readonly Span[], resourceId: ResourceId | null): Span[] {
  const parts: Span[] = [];
  const ranges = mergedRanges(busy);
  const pauses = [...breaks].sort((a, b) => a.after - b.after);
  let [range, pause, done] = [0, 0, 0];
  let half = calendar.snapHalf(start, resourceId);
  let partStart: HalfDay | null = null;
  let last = half;
  const closePart = () => {
    if (partStart !== null) parts.push(spanOfHalves(partStart, last));
    partStart = null;
  };
  while (done < halves) {
    while (ranges[range] && ranges[range]!.to < half) range++;
    const blocking = ranges[range];
    if (blocking && blocking.from <= half) {
      closePart();
      half = calendar.snapHalf(blocking.to + 1, resourceId);
      continue;
    }
    partStart ??= half;
    last = half;
    done++;
    while (pauses[pause] && pauses[pause]!.after < done) pause++;
    if (pauses[pause]?.after === done && done < halves) {
      closePart();
      half = calendar.addWorkingHalves(half, pauses[pause]!.length, resourceId);
    }
    half = calendar.nextHalfAfter(half, resourceId);
  }
  closePart();
  return parts;
}

/** Parts as drawn: also split at holidays and time off, which are never stored. A weekend alone doesn't split. */
export function visibleParts(parts: readonly Span[], calendar: Calendar, resourceId: ResourceId | null): Span[] {
  const shown: Span[] = [];
  for (const part of parts) {
    let from = spanStart(part);
    for (let day = part.start; day <= part.end; day++) {
      if (calendar.isWorkingDay(day, resourceId)) continue;
      const first = day;
      let breaksBar = false;
      for (; day <= part.end && !calendar.isWorkingDay(day, resourceId); day++) breaksBar ||= !calendar.isRestDay(day);
      if (breaksBar) {
        shown.push(spanOfHalves(from, halfDay(first - 1, true)));
        from = halfDay(day);
      }
      day--;
    }
    shown.push(spanOfHalves(from, spanEnd(part)));
  }
  return shown;
}

/**
 * Clears what a task can no longer have, in place: interruptions on anything but a task with length and
 * no subtasks, interrupters that are gone or aren't such tasks, and breaks past its work. Returns how
 * many rows it changed.
 */
export function clearLostInterruptions(rows: Record<RowId, Row>): number {
  const affected = Object.values(rows).filter((row) => row.kind === "task" && ((row.breaks?.length ?? 0) > 0 || (row.interruptedBy?.length ?? 0) > 0));
  if (affected.length === 0) return 0;
  const parents = new Set(Object.values(rows).flatMap((row) => (row.parentId === null ? [] : [row.parentId])));
  const canTakePart = (row: Row | undefined) => row?.kind === "task" && row.duration > 0 && !parents.has(row.id);
  let cleared = 0;
  for (const row of affected) {
    if (row.kind !== "task") continue;
    const [breaks, interruptedBy] = [row.breaks ?? [], row.interruptedBy ?? []];
    const keptBreaks = canTakePart(row) ? breaks.filter((pause) => pause.after >= 1 && pause.after < row.duration * 2) : [];
    const keptBy = canTakePart(row) ? interruptedBy.filter((id) => id !== row.id && canTakePart(rows[id])) : [];
    if (keptBreaks.length === breaks.length && keptBy.length === interruptedBy.length) continue;
    rows[row.id] = { ...row, breaks: keptBreaks, interruptedBy: keptBy };
    cleared++;
  }
  return cleared;
}
