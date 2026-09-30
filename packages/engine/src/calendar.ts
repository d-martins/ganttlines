import { dayOf, halfDay, toDay, weekday, type DayNum, type HalfDay, type IsoDate } from "./date";

export type ResourceId = string;

export interface Holiday {
  id: string;
  name: string;
  startDate: IsoDate;
  endDate: IsoDate;
  appliesTo: "all" | ResourceId[];
}

export interface TimeOff {
  id: string;
  resourceId: ResourceId;
  startDate: IsoDate;
  endDate: IsoDate;
}

export interface CalendarData {
  /** 0 = Sunday … 6 = Saturday */
  workingWeekdays: number[];
  holidays: Holiday[];
  timeOff: TimeOff[];
}

/**
 * Longest run of consecutive non-working days a calendar may contain (~10 years). Longer
 * holiday / time-off stretches are ignored (see `dropLongRuns`), so every walk finds a working
 * day quickly and one calendar can never make a project unschedulable.
 */
const MAX_NON_WORKING_RUN = 3660;

/**
 * Answers "is this a working day for this resource?" and walks working days.
 * `resourceId = null` means an unassigned task: only weekdays and all-team holidays apply.
 */
export class Calendar {
  private readonly weekdays: ReadonlySet<number>;
  private readonly teamOff = new Set<DayNum>();
  private readonly resourceOff = new Map<ResourceId, Set<DayNum>>();

  constructor(data: CalendarData) {
    this.weekdays = new Set(data.workingWeekdays);
    if (!data.workingWeekdays.every((w) => Number.isInteger(w) && w >= 0 && w <= 6)) {
      throw new RangeError("Working weekdays must be integers from 0 (Sunday) to 6 (Saturday)");
    }
    if (this.weekdays.size === 0) throw new RangeError("At least one working weekday is required");
    for (const holiday of data.holidays) {
      if (holiday.appliesTo === "all") addRange(this.teamOff, holiday.startDate, holiday.endDate);
      else for (const id of holiday.appliesTo) addRange(this.offFor(id), holiday.startDate, holiday.endDate);
    }
    for (const entry of data.timeOff) addRange(this.offFor(entry.resourceId), entry.startDate, entry.endDate);
    // Team first (weekday gaps alone are ≤ 6 days), then each resource on top of the team calendar.
    dropLongRuns(this.teamOff, (day) => !this.isWorkingDay(day, null));
    for (const [resourceId, off] of this.resourceOff) dropLongRuns(off, (day) => !this.isWorkingDay(day, resourceId));
  }

  isWorkingDay(day: DayNum, resourceId: ResourceId | null): boolean {
    if (!this.weekdays.has(weekday(day))) return false;
    if (this.teamOff.has(day)) return false;
    return !(resourceId !== null && this.resourceOff.get(resourceId)?.has(day));
  }

  /** `day` if it is a working day, otherwise the next working day. */
  snap(day: DayNum, resourceId: ResourceId | null): DayNum {
    return this.scan(day, 1, resourceId);
  }

  /** `day` if it is a working day, otherwise the previous working day. */
  snapBack(day: DayNum, resourceId: ResourceId | null): DayNum {
    return this.scan(day, -1, resourceId);
  }

  /** First working day strictly after `day`. */
  nextAfter(day: DayNum, resourceId: ResourceId | null): DayNum {
    return this.scan(day + 1, 1, resourceId);
  }

  /** Moves `n` working days from working day `day` (negative `n` moves backwards). */
  addWorkingDays(day: DayNum, n: number, resourceId: ResourceId | null): DayNum {
    const step = n < 0 ? -1 : 1;
    let current = day;
    for (let remaining = Math.abs(n); remaining > 0; remaining--) {
      current = this.scan(current + step, step, resourceId);
    }
    return current;
  }

  /** Signed k such that addWorkingDays(from, k) === to. Both days must be working days. */
  workingDaysBetween(from: DayNum, to: DayNum, resourceId: ResourceId | null): number {
    if (!Number.isInteger(from) || !Number.isInteger(to)) throw new RangeError("Day numbers must be integers");
    const step = to >= from ? 1 : -1;
    let count = 0;
    for (let day = from; day !== to; ) {
      day += step;
      if (this.isWorkingDay(day, resourceId)) count += step;
    }
    return count;
  }

  // ── half days: a half day is working when its day is ──────────────────

  /** `half` if its day is a working day, otherwise the morning of the next working day. */
  snapHalf(half: HalfDay, resourceId: ResourceId | null): HalfDay {
    const day = dayOf(half);
    return this.isWorkingDay(day, resourceId) ? half : halfDay(this.snap(day + 1, resourceId));
  }

  /** `half` if its day is a working day, otherwise the afternoon of the previous working day. */
  snapHalfBack(half: HalfDay, resourceId: ResourceId | null): HalfDay {
    const day = dayOf(half);
    return this.isWorkingDay(day, resourceId) ? half : halfDay(this.snapBack(day - 1, resourceId), true);
  }

  /** First working half day strictly after `half`. */
  nextHalfAfter(half: HalfDay, resourceId: ResourceId | null): HalfDay {
    return this.snapHalf(half + 1, resourceId);
  }

  /** Moves `n` working half days from working half day `half` (negative `n` moves backwards). */
  addWorkingHalves(half: HalfDay, n: number, resourceId: ResourceId | null): HalfDay {
    let current = half;
    for (let remaining = Math.abs(n); remaining > 0; remaining--) {
      current = n < 0 ? this.snapHalfBack(current - 1, resourceId) : this.snapHalf(current + 1, resourceId);
    }
    return current;
  }

  /** Signed k such that addWorkingHalves(from, k) === to. Both must be working half days. */
  workingHalvesBetween(from: HalfDay, to: HalfDay, resourceId: ResourceId | null): number {
    if (!Number.isInteger(from) || !Number.isInteger(to)) throw new RangeError("Half days must be integers");
    const step = to >= from ? 1 : -1;
    let count = 0;
    for (let half = from; half !== to; ) {
      half += step;
      if (this.isWorkingDay(dayOf(half), resourceId)) count += step;
    }
    return count;
  }

  private scan(start: DayNum, step: 1 | -1, resourceId: ResourceId | null): DayNum {
    for (let i = 0, day = start; i <= MAX_NON_WORKING_RUN; i++, day += step) {
      if (this.isWorkingDay(day, resourceId)) return day;
    }
    // Unreachable safety net: the constructor guarantees no longer non-working runs.
    return start;
  }

  private offFor(resourceId: ResourceId): Set<DayNum> {
    let off = this.resourceOff.get(resourceId);
    if (!off) {
      off = new Set();
      this.resourceOff.set(resourceId, off);
    }
    return off;
  }
}

function addRange(target: Set<DayNum>, startDate: IsoDate, endDate: IsoDate): void {
  const start = toDay(startDate);
  const end = toDay(endDate);
  if (end < start) throw new RangeError(`Range ends before it starts: ${startDate} … ${endDate}`);
  for (let day = start; day <= end; day++) target.add(day);
}

/**
 * Removes from `off` every day inside a maximal run of consecutive non-working days (as
 * `isOff` reports them) longer than MAX_NON_WORKING_RUN. Only runs that contain a day of
 * `off` are visited, so the cost is proportional to the size of `off`.
 */
function dropLongRuns(off: Set<DayNum>, isOff: (day: DayNum) => boolean): void {
  const days = [...off].sort((a, b) => a - b);
  let coveredUntil = -Infinity;
  for (const day of days) {
    if (day <= coveredUntil) continue;
    let start = day;
    while (isOff(start - 1)) start--;
    let end = day;
    while (isOff(end + 1)) end++;
    coveredUntil = end;
    if (end - start + 1 > MAX_NON_WORKING_RUN) for (let d = start; d <= end; d++) off.delete(d);
  }
}
