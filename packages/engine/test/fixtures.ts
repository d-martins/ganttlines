import { generateNKeysBetween } from "fractional-indexing";
import { Calendar, type CalendarData } from "../src/calendar";
import { fromDay } from "../src/date";
import { TASK_DEFAULTS, type ProjectState, type Row, type SectionRow, type TaskRow } from "../src/model";
import type { Schedule } from "../src/schedule";

export const MON_FRI = [1, 2, 3, 4, 5];
export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

export function calendar(data: Partial<CalendarData> = {}): Calendar {
  return new Calendar({ workingWeekdays: MON_FRI, holidays: [], timeOff: [], ...data });
}

export function task(id: string, fields: Partial<TaskRow> = {}): TaskRow {
  return { ...TASK_DEFAULTS, id, kind: "task", title: id, parentId: null, position: "", collapsed: false, ...fields };
}

export function section(id: string, fields: Partial<SectionRow> = {}): SectionRow {
  return { id, kind: "section", title: id, parentId: null, position: "", collapsed: false, ...fields };
}

/** Builds a project; rows without a position are ordered among their siblings as listed. */
export function project(...rows: Row[]): ProjectState {
  const byParent = new Map<string | null, Row[]>();
  for (const row of rows) byParent.set(row.parentId, [...(byParent.get(row.parentId) ?? []), row]);
  const positioned: Record<string, Row> = {};
  for (const siblings of byParent.values()) {
    const keys = generateNKeysBetween(null, null, siblings.length);
    siblings.forEach((row, i) => (positioned[row.id] = row.position ? row : { ...row, position: keys[i]! }));
  }
  return { rows: positioned };
}

export function datesOf(schedule: Schedule, id: string): { start: string; end: string } | null {
  const span = schedule.get(id)?.span;
  return span ? { start: fromDay(span.start), end: fromDay(span.end) } : null;
}

/** A row's dates with their halves: "2026-10-06 pm" starts in the afternoon, "2026-10-08 am" ends at midday. */
export function halvesOf(schedule: Schedule, id: string): { start: string; end: string } | null {
  const span = schedule.get(id)?.span;
  if (!span) return null;
  return { start: `${fromDay(span.start)} ${span.startsAfternoon ? "pm" : "am"}`, end: `${fromDay(span.end)} ${span.endsMidday ? "am" : "pm"}` };
}
