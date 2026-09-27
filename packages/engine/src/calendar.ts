import { toDay, weekday, type DayNum, type IsoDate } from "./date";

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
 * Longest run of consecutive non-working days we search through (~10 years). Beyond it (e.g. a
 * person marked off for decades) the calendar falls back to treating the day as working, so
 * scheduling stays total: one resource's calendar can never make the whole project unschedulable.
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

  /**
   * Signed k such that addWorkingDays(from, k) === to. Both days must be working days
   * (days reached only through the no-working-day fallback are not counted).
   */
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

  private scan(start: DayNum, step: 1 | -1, resourceId: ResourceId | null): DayNum {
    for (let i = 0, day = start; i < MAX_NON_WORKING_RUN; i++, day += step) {
      if (this.isWorkingDay(day, resourceId)) return day;
    }
    return start; // fallback: no working day nearby, so `start` is used as if it were working
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
