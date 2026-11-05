import { describe, expect, it } from "vitest";
import { baselineTasks } from "../src/baseline";
import { applyCommand } from "../src/commands";
import { fromDay, toDay } from "../src/date";
import type { Row, RowId, ProjectState, TaskRow } from "../src/model";
import { clearLostInterruptions, layOutWork, partsOf, pausesOf, visibleParts } from "../src/parts";
import { computeSchedule, hasCycle, linkRequirement, spanEnd, spanStart, type Schedule } from "../src/schedule";
import { revertChanges } from "../src/undo";
import { workedDays } from "../src/worked";
import { calendar, link, project, task } from "./fixtures";
import { run } from "./helpers";

const cal = calendar();
const MON = "2026-11-02";
const dates = (schedule: Schedule, id: RowId) => partsOf(schedule.get(id)!).map((part) => [fromDay(part.start), fromDay(part.end)]);
const fixLogin = (fields: Partial<TaskRow> = {}) => task("t", { userStart: MON, duration: 2, breaks: [{ after: 2, length: 6 }], ...fields });

describe("work in parts", () => {
  it("a break of 3 days after one day: Monday, then Friday", () => {
    const schedule = computeSchedule(project(fixLogin()), cal);
    expect(dates(schedule, "t")).toEqual([[MON, MON], ["2026-11-06", "2026-11-06"]]);
    expect(schedule.get("t")!.span).toMatchObject({ start: toDay(MON), end: toDay("2026-11-06") });
  });

  it("no break, no parts", () => {
    const computed = computeSchedule(project(task("t", { userStart: MON, duration: 2 })), cal).get("t")!;
    expect(computed).not.toHaveProperty("parts");
    expect(dates(new Map([["t", computed]]), "t")).toEqual([[MON, "2026-11-03"]]);
  });

  it("moving keeps the shape", () => {
    const schedule = computeSchedule(project(fixLogin({ userStart: "2026-11-09" })), cal);
    expect(dates(schedule, "t")).toEqual([["2026-11-09", "2026-11-09"], ["2026-11-13", "2026-11-13"]]);
  });

  it("a holiday inside the gap pushes the rest out by a day; WD unchanged", () => {
    const holiday = calendar({ holidays: [{ id: "h", name: "h", startDate: "2026-11-04", endDate: "2026-11-04", appliesTo: "all" }] });
    const state = project(fixLogin());
    expect(dates(computeSchedule(state, holiday), "t")).toEqual([[MON, MON], ["2026-11-09", "2026-11-09"]]);
    expect(dates(computeSchedule(state, cal), "t")).toEqual([[MON, MON], ["2026-11-06", "2026-11-06"]]);
    expect(state.rows["t"]).toMatchObject({ duration: 2 });
  });

  it("half days", () => {
    const part = partsOf(computeSchedule(project(task("t", { userStart: MON, duration: 1.5, breaks: [{ after: 1, length: 1 }] })), cal).get("t")!);
    expect(part.map((span) => [spanStart(span) - spanStart(part[0]!), spanEnd(span) - spanStart(part[0]!)])).toEqual([[0, 0], [2, 3]]);
  });

  it("A interrupts B: B pauses while A runs", () => {
    const state = project(task("a", { userStart: "2026-11-03", duration: 3 }), task("b", { userStart: MON, duration: 2, interruptedBy: ["a"] }));
    const schedule = computeSchedule(state, cal);
    expect(dates(schedule, "b")).toEqual([[MON, MON], ["2026-11-06", "2026-11-06"]]);
    expect(dates(schedule, "a")).toEqual([["2026-11-03", "2026-11-05"]]);
  });

  it("B works in A's gaps", () => {
    const a = task("a", { userStart: "2026-11-03", duration: 2, breaks: [{ after: 2, length: 2 }] }); // Tue, Thu
    const schedule = computeSchedule(project(a, task("b", { userStart: MON, duration: 3, interruptedBy: ["a"] })), cal);
    expect(dates(schedule, "b")).toEqual([[MON, MON], ["2026-11-04", "2026-11-04"], ["2026-11-06", "2026-11-06"]]);
  });

  it("A covering B's start: B starts after A, one part", () => {
    const schedule = computeSchedule(project(task("a", { userStart: MON, duration: 2 }), task("b", { userStart: "2026-11-03", duration: 2, interruptedBy: ["a"] })), cal);
    expect(dates(schedule, "b")).toEqual([["2026-11-04", "2026-11-05"]]);
    expect(schedule.get("b")).not.toHaveProperty("parts");
  });

  it("two overlapping interrupters are one stretch", () => {
    const state = project(task("a", { userStart: "2026-11-03", duration: 2 }), task("c", { userStart: "2026-11-04", duration: 2 }), task("b", { userStart: MON, duration: 2, interruptedBy: ["a", "c"] }));
    expect(dates(computeSchedule(state, cal), "b")).toEqual([[MON, MON], ["2026-11-06", "2026-11-06"]]);
  });

  it("several interrupters with long durations finish", () => {
    const interrupters = Array.from({ length: 200 }, (_, i) => task(`a${i}`, { userStart: fromDay(toDay(MON) + i * 400), duration: 365 }));
    const state = project(...interrupters, task("b", { userStart: MON, duration: 1000, interruptedBy: interrupters.map((row) => row.id) }));
    const before = Date.now();
    computeSchedule(state, cal);
    expect(Date.now() - before).toBeLessThan(2000);
  });

  it("interrupting each other is a cycle, also through a link", () => {
    expect(hasCycle(project(task("a", { userStart: MON, interruptedBy: ["b"] }), task("b", { userStart: MON, interruptedBy: ["a"] })), cal)).toBe(true);
    expect(hasCycle(project(task("a", { userStart: MON }), task("b", { userStart: MON, interruptedBy: ["a"] }), link("b", "a")), cal)).toBe(true);
  });

  it("a locked task ignores interrupters", () => {
    const state = project(task("a", { userStart: MON, duration: 2 }), task("b", { userStart: MON, duration: 2, locked: true, interruptedBy: ["a"] }));
    expect(dates(computeSchedule(state, cal), "b")).toEqual([[MON, "2026-11-03"]]);
  });

  it("FF follower with a break starts early enough to end on the link", () => {
    const predecessor = computeSchedule(project(task("p", { userStart: "2026-11-09", duration: 1 })), cal).get("p")!.span!;
    const plain = linkRequirement(cal, { resourceId: null, duration: 2 }, link("p", "t", 0, "FF"), predecessor);
    const split = linkRequirement(cal, { resourceId: null, duration: 2, breaks: [{ after: 2, length: 6 }] }, link("p", "t", 0, "FF"), predecessor);
    expect(cal.workingHalvesBetween(split, plain, null)).toBe(6);
  });

  it("followers and parents use the last part", () => {
    const state = project(task("up", { userStart: MON }), fixLogin({ parentId: "up" }), task("next", { userStart: MON }), link("t", "next"));
    const schedule = computeSchedule(state, cal);
    expect(dates(schedule, "next")).toEqual([["2026-11-09", "2026-11-09"]]);
    expect(dates(schedule, "up")).toEqual([[MON, "2026-11-06"]]);
  });
});

describe("visibleParts", () => {
  const off = (from: string, to: string) => ({ id: from, name: from, startDate: from, endDate: to, appliesTo: "all" as const });
  const shown = (fields: Partial<TaskRow>, calendarUsed = cal) => {
    const schedule = computeSchedule(project(task("t", { userStart: MON, ...fields })), calendarUsed);
    return visibleParts(partsOf(schedule.get("t")!), calendarUsed, fields.resourceId ?? null).map((part) => [fromDay(part.start), fromDay(part.end)]);
  };

  it("a holiday splits, a weekend doesn't", () => {
    expect(shown({ duration: 8 })).toEqual([[MON, "2026-11-11"]]);
    expect(shown({ duration: 3 }, calendar({ holidays: [off("2026-11-03", "2026-11-03")] }))).toEqual([[MON, MON], ["2026-11-04", "2026-11-05"]]);
  });

  it("a holiday beside a weekend is one gap", () => {
    expect(shown({ duration: 6 }, calendar({ holidays: [off("2026-11-06", "2026-11-06")] }))).toEqual([[MON, "2026-11-05"], ["2026-11-09", "2026-11-10"]]);
  });

  it("time off splits only for that person, and follows a reassignment", () => {
    const withOff = calendar({ timeOff: [{ id: "o", resourceId: "ana", startDate: "2026-11-03", endDate: "2026-11-03" }] });
    expect(shown({ duration: 3, resourceId: "ana" }, withOff)).toEqual([[MON, MON], ["2026-11-04", "2026-11-05"]]);
    expect(shown({ duration: 3, resourceId: "bo" }, withOff)).toEqual([[MON, "2026-11-04"]]);
  });
});

describe("what's lost", () => {
  const cleared = (...rows: Row[]) => {
    const record: Record<RowId, Row> = Object.fromEntries(rows.map((row) => [row.id, row]));
    clearLostInterruptions(record);
    return record;
  };

  it("drops interrupters that are gone, or no longer tasks with length", () => {
    const rows = cleared(task("m", { duration: 0 }), task("up"), task("kid", { parentId: "up" }), task("a"), task("b", { interruptedBy: ["gone", "m", "up", "a"] }));
    expect(rows["b"]).toMatchObject({ interruptedBy: ["a"] });
  });

  it("drops breaks past the task's work", () => {
    expect(cleared(task("t", { duration: 1, breaks: [{ after: 1, length: 2 }, { after: 2, length: 2 }] }))["t"]).toMatchObject({ breaks: [{ after: 1, length: 2 }] });
  });

  it("clears both on milestones and parents", () => {
    const rows = cleared(task("a"), task("m", { duration: 0, breaks: [{ after: 1, length: 1 }], interruptedBy: ["a"] }), task("up", { breaks: [{ after: 1, length: 1 }] }), task("kid", { parentId: "up" }));
    expect(rows["m"]).toMatchObject({ breaks: [], interruptedBy: [] });
    expect(rows["up"]).toMatchObject({ breaks: [] });
  });

  it("leaves a row that needs nothing as the same object", () => {
    const row = task("t");
    expect(cleared(row)["t"]).toBe(row);
  });

  it("undo of deleting the interrupter restores the relation and the gap", () => {
    const before = project(task("a", { userStart: "2026-11-03", duration: 3 }), task("b", { userStart: MON, duration: 2, interruptedBy: ["a"] }));
    const deleted = applyCommand(before, cal, { type: "deleteRows", ids: ["a"] });
    if (!deleted.ok) throw new Error(deleted.message);
    expect(deleted.state.rows["b"]).toMatchObject({ interruptedBy: [] });
    expect(dates(computeSchedule(deleted.state, cal), "b")).toEqual([[MON, "2026-11-03"]]);
    const undone = revertChanges(deleted.state, deleted.changes, "undo").state;
    expect(undone.rows["b"]).toMatchObject({ interruptedBy: ["a"] });
    expect(dates(computeSchedule(undone, cal), "b")).toEqual([[MON, MON], ["2026-11-06", "2026-11-06"]]);
  });
});

describe("what reads parts", () => {
  it("workedDays skips gap days", () => {
    const state: ProjectState = project(task("up"), fixLogin({ parentId: "up" }));
    expect(workedDays(state, computeSchedule(state, cal), cal, "up")).toBe(2);
  });

  it("baselines save parts only when split", () => {
    const tasks = baselineTasks(project(fixLogin(), task("plain", { userStart: MON })), cal);
    expect(tasks.find((row) => row.rowId === "t")!.parts).toEqual([
      { start: MON, end: MON, startsAfternoon: false, endsMidday: false },
      { start: "2026-11-06", end: "2026-11-06", startsAfternoon: false, endsMidday: false },
    ]);
    expect(tasks.find((row) => row.rowId === "plain")).not.toHaveProperty("parts");
  });

  it("a duplicate copies its own breaks, not who interrupts it", () => {
    const state = project(task("a", { userStart: MON }), fixLogin({ interruptedBy: ["a"] }));
    const copied = run(state, cal, { type: "duplicateTask", id: "t", newId: "copy" });
    expect(copied.rows["copy"]).toMatchObject({ breaks: [{ after: 2, length: 6 }], interruptedBy: [] });
  });

  it("layOutWork with nothing in the way is one part", () => {
    expect(layOutWork(cal, toDay(MON) * 2, 4, [], [], null)).toHaveLength(1);
  });

  it("pausesOf says where each stored pause sits", () => {
    const state = project(fixLogin());
    const row = state.rows["t"] as TaskRow;
    const [pause] = pausesOf(row, partsOf(computeSchedule(state, cal).get("t")), cal);
    expect(pause).toMatchObject({ after: 2 });
    expect(fromDay(pause!.lastWorked >> 1)).toBe(MON);
    expect(fromDay(pause!.resume >> 1)).toBe("2026-11-06");
  });
});
