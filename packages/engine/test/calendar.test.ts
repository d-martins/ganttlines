import { describe, expect, it } from "vitest";
import { Calendar } from "../src/calendar";
import { toDay } from "../src/date";

const MON_FRI = [1, 2, 3, 4, 5];
const d = toDay;

// Week of 2026-10-05 (Mon) … 2026-10-11 (Sun)
describe("Calendar", () => {
  const cal = new Calendar({
    workingWeekdays: MON_FRI,
    holidays: [
      { id: "h1", name: "Team day", startDate: "2026-10-07", endDate: "2026-10-07", appliesTo: "all" },
      { id: "h2", name: "Local holiday", startDate: "2026-10-08", endDate: "2026-10-08", appliesTo: ["ana"] },
    ],
    timeOff: [{ id: "t1", resourceId: "rudy", startDate: "2026-10-05", endDate: "2026-10-06" }],
  });

  it("applies weekends, team holidays, targeted holidays and time off", () => {
    expect(cal.isWorkingDay(d("2026-10-05"), null)).toBe(true);
    expect(cal.isWorkingDay(d("2026-10-10"), null)).toBe(false); // Saturday
    expect(cal.isWorkingDay(d("2026-10-07"), null)).toBe(false); // team holiday
    expect(cal.isWorkingDay(d("2026-10-08"), null)).toBe(true); // Ana's holiday only
    expect(cal.isWorkingDay(d("2026-10-08"), "ana")).toBe(false);
    expect(cal.isWorkingDay(d("2026-10-05"), "rudy")).toBe(false); // time off
    expect(cal.isWorkingDay(d("2026-10-05"), "ana")).toBe(true);
  });

  it("snaps forward and backward to working days", () => {
    expect(cal.snap(d("2026-10-10"), null)).toBe(d("2026-10-12"));
    expect(cal.snap(d("2026-10-05"), "rudy")).toBe(d("2026-10-08"));
    expect(cal.snapBack(d("2026-10-11"), null)).toBe(d("2026-10-09"));
    expect(cal.snap(d("2026-10-06"), null)).toBe(d("2026-10-06"));
  });

  it("finds the first working day strictly after a day", () => {
    expect(cal.nextAfter(d("2026-10-06"), null)).toBe(d("2026-10-08"));
    expect(cal.nextAfter(d("2026-10-06"), "ana")).toBe(d("2026-10-09"));
  });

  it("adds and counts working days in both directions", () => {
    expect(cal.addWorkingDays(d("2026-10-05"), 3, null)).toBe(d("2026-10-09"));
    expect(cal.addWorkingDays(d("2026-10-09"), -3, null)).toBe(d("2026-10-05"));
    expect(cal.addWorkingDays(d("2026-10-05"), 0, null)).toBe(d("2026-10-05"));
    expect(cal.workingDaysBetween(d("2026-10-05"), d("2026-10-09"), null)).toBe(3);
    expect(cal.workingDaysBetween(d("2026-10-09"), d("2026-10-05"), null)).toBe(-3);
    expect(cal.workingDaysBetween(d("2026-10-09"), d("2026-10-12"), null)).toBe(1);
  });

  it("requires at least one working weekday", () => {
    expect(() => new Calendar({ workingWeekdays: [], holidays: [], timeOff: [] })).toThrow(RangeError);
  });
});

describe("Calendar input validation", () => {
  it("rejects weekdays outside 0–6", () => {
    expect(() => new Calendar({ workingWeekdays: [7], holidays: [], timeOff: [] })).toThrow(RangeError);
    expect(() => new Calendar({ workingWeekdays: [1.5], holidays: [], timeOff: [] })).toThrow(RangeError);
  });

  it("rejects ranges that end before they start", () => {
    expect(
      () =>
        new Calendar({
          workingWeekdays: MON_FRI,
          holidays: [{ id: "h", name: "", startDate: "2026-10-09", endDate: "2026-10-05", appliesTo: "all" }],
          timeOff: [],
        }),
    ).toThrow(RangeError);
  });

  it("rejects fractional day numbers when counting working days", () => {
    const cal = new Calendar({ workingWeekdays: MON_FRI, holidays: [], timeOff: [] });
    expect(() => cal.workingDaysBetween(d("2026-10-05"), d("2026-10-09") + 0.5, null)).toThrow(RangeError);
  });

  it("skips multi-day time off that spans a weekend", () => {
    const cal = new Calendar({
      workingWeekdays: MON_FRI,
      holidays: [],
      timeOff: [{ id: "t", resourceId: "ana", startDate: "2026-10-09", endDate: "2026-10-13" }],
    });
    // Thu 8 + 1 working day for Ana: Fri 9, Mon 12, Tue 13 are off → Wed 14
    expect(cal.addWorkingDays(d("2026-10-08"), 1, "ana")).toBe(d("2026-10-14"));
    expect(cal.addWorkingDays(d("2026-10-08"), 1, "rudy")).toBe(d("2026-10-09"));
  });
});
