import { weekday, type DayNum } from "@ganttlines/engine";

export type Zoom = "day" | "week" | "month";
export const DAY_WIDTH: Record<Zoom, number> = { day: 32, week: 12, month: 4 };

/**
 * Maps days to horizontal pixels. Hidden days (the team's non-working weekdays when weekends
 * are hidden) take no space: a bar across a weekend shortens, and a hidden day maps to the start
 * of the next visible one.
 */
export class Timeline {
  /** visible days in order */
  readonly days: readonly DayNum[];
  readonly width: number;
  /** visible days before each day of the range (index = day - first) */
  private readonly before: Int32Array;

  constructor(
    readonly first: DayNum,
    readonly last: DayNum,
    readonly dayWidth: number,
    readonly isHidden: (day: DayNum) => boolean = () => false,
  ) {
    const before = new Int32Array(last - first + 2);
    const days: DayNum[] = [];
    for (let day = first; day <= last; day++) {
      before[day - first] = days.length;
      if (!isHidden(day)) days.push(day);
    }
    before[last - first + 1] = days.length;
    this.before = before;
    this.days = days;
    this.width = days.length * dayWidth;
  }

  /** Left edge of `day` (days outside the range are clamped to it). */
  x(day: DayNum): number {
    const clamped = Math.min(Math.max(day, this.first), this.last + 1);
    return this.before[clamped - this.first]! * this.dayWidth;
  }

  /** Right edge of `day`: where a bar ending on it (inclusive) stops. */
  xEnd(day: DayNum): number {
    const clamped = Math.min(Math.max(day, this.first - 1), this.last);
    return this.before[clamped - this.first + 1]! * this.dayWidth;
  }

  /** The visible day under `x`. */
  dayAt(x: number): DayNum {
    const index = Math.min(Math.max(Math.floor(x / this.dayWidth), 0), this.days.length - 1);
    return this.days[index] ?? this.first;
  }

  /** Visible days whose columns overlap [left, right). */
  daysBetween(left: number, right: number): DayNum[] {
    const from = Math.max(Math.floor(left / this.dayWidth), 0);
    const to = Math.min(Math.ceil(right / this.dayWidth), this.days.length);
    return this.days.slice(from, to);
  }
}

/**
 * The range the chart shows: every date in `days` plus today, padded (more room ahead than
 * behind) and starting on a Monday so week columns line up.
 */
export function chartRange(days: Iterable<DayNum>, today: DayNum): { first: DayNum; last: DayNum } {
  let first = today;
  let last = today;
  for (const day of days) {
    if (day < first) first = day;
    if (day > last) last = day;
  }
  first -= 28;
  first -= (weekday(first) + 6) % 7;
  return { first, last: last + 120 };
}
