/**
 * Calendar dates cross the wire as ISO strings ("YYYY-MM-DD").
 * Internally the engine works with day numbers: whole days since 1970-01-01 (UTC).
 */
export type IsoDate = string;
export type DayNum = number;

const MS_PER_DAY = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function toDay(iso: IsoDate): DayNum {
  const match = ISO_DATE.exec(iso);
  if (!match) throw new RangeError(`Invalid ISO date: ${iso}`);
  const day = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / MS_PER_DAY;
  if (fromDay(day) !== iso) throw new RangeError(`Invalid ISO date: ${iso}`);
  return day;
}

export function fromDay(day: DayNum): IsoDate {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. 1970-01-01 was a Thursday. */
export function weekday(day: DayNum): number {
  return (((day + 4) % 7) + 7) % 7;
}

/**
 * Time in half days: `day * 2` is a day's morning, `day * 2 + 1` its afternoon. The schedule works in
 * half days; stored dates stay whole days (plus a task's "starts in the afternoon" flag).
 */
export type HalfDay = number;

export const halfDay = (day: DayNum, afternoon = false): HalfDay => day * 2 + (afternoon ? 1 : 0);
export const dayOf = (half: HalfDay): DayNum => Math.floor(half / 2);
export const isAfternoon = (half: HalfDay): boolean => half - dayOf(half) * 2 === 1;
