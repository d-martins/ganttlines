import { describe, expect, it } from "vitest";
import { linkKey } from "../src/links";
import { halfDay, toDay } from "../src/date";
import { computeSchedule, constraintsFor, CycleError, hasCycle, linkFloor, violatedLinks } from "../src/schedule";
import type { TaskRow } from "../src/model";
import { isAncestor } from "../src/tree";
import { calendar, datesOf, halvesOf, link, project, section, task } from "./fixtures";

// October 2026: Mon 5, Tue 6, Wed 7, Thu 8, Fri 9, Sat 10, Sun 11, Mon 12 …
const cal = calendar({
  timeOff: [{ id: "t1", resourceId: "ana", startDate: "2026-10-07", endDate: "2026-10-08" }],
});

describe("computeSchedule — leaf tasks", () => {
  it("leaves unscheduled tasks without dates", () => {
    const schedule = computeSchedule(project(task("a")), cal);
    expect(datesOf(schedule, "a")).toBeNull();
  });

  it("covers `duration` working days, skipping weekends", () => {
    const schedule = computeSchedule(project(task("a", { userStart: "2026-10-08", duration: 3 })), cal);
    expect(datesOf(schedule, "a")).toEqual({ start: "2026-10-08", end: "2026-10-12" });
  });

  it("snaps a weekend start to the next working day", () => {
    const schedule = computeSchedule(project(task("a", { userStart: "2026-10-10", duration: 1 })), cal);
    expect(datesOf(schedule, "a")).toEqual({ start: "2026-10-12", end: "2026-10-12" });
  });

  it("stretches around the assignee's time off", () => {
    const schedule = computeSchedule(
      project(task("a", { userStart: "2026-10-05", duration: 3, resourceId: "ana" })),
      cal,
    );
    expect(datesOf(schedule, "a")).toEqual({ start: "2026-10-05", end: "2026-10-09" });
  });

  it("gives milestones a single day", () => {
    const schedule = computeSchedule(project(task("m", { userStart: "2026-10-06", duration: 0 })), cal);
    expect(datesOf(schedule, "m")).toEqual({ start: "2026-10-06", end: "2026-10-06" });
  });
});

describe("computeSchedule — predecessors", () => {
  const a = task("a", { userStart: "2026-10-05", duration: 3 }); // Mon 5 – Wed 7

  it("pushes a successor to the working day after its predecessor ends", () => {
    const schedule = computeSchedule(project(a, task("b", { userStart: "2026-10-05" }), link("a", "b")), cal);
    expect(datesOf(schedule, "b")?.start).toBe("2026-10-08");
  });

  it("keeps the user's later start", () => {
    const schedule = computeSchedule(project(a, task("b", { userStart: "2026-10-13" }), link("a", "b")), cal);
    expect(datesOf(schedule, "b")?.start).toBe("2026-10-13");
  });

  it("allows overlap through a negative offset", () => {
    const b = [task("b", { userStart: "2026-10-05" }), link("a", "b", -2)];
    expect(datesOf(computeSchedule(project(a, ...b), cal), "b")?.start).toBe("2026-10-06");
  });

  it("never starts on or before the predecessor's start", () => {
    const b = [task("b", { userStart: "2026-10-01" }), link("a", "b", -10)];
    expect(datesOf(computeSchedule(project(a, ...b), cal), "b")?.start).toBe("2026-10-06");
  });

  it("adds a positive offset as a gap in working days", () => {
    const b = [task("b", { userStart: "2026-10-05" }), link("a", "b", 2)];
    expect(datesOf(computeSchedule(project(a, ...b), cal), "b")?.start).toBe("2026-10-12");
  });

  it("measures the successor's rules on the successor's own calendar", () => {
    const b = [task("b", { userStart: "2026-10-05", resourceId: "ana" }), link("a", "b")];
    // natural day after Wed 7 is Thu 8, but Ana is off Thu 8 → Fri 9
    expect(datesOf(computeSchedule(project(a, ...b), cal), "b")?.start).toBe("2026-10-09");
  });

  it("chains pushes through several tasks", () => {
    const schedule = computeSchedule(
      project(
        a,
        task("b", { userStart: "2026-10-05", duration: 2 }),
        link("a", "b"),
        task("c", { userStart: "2026-10-05" }),
        link("b", "c"),
      ),
      cal,
    );
    expect(datesOf(schedule, "c")?.start).toBe("2026-10-12");
  });

  it("ignores unscheduled predecessors", () => {
    const schedule = computeSchedule(project(task("x"), task("b", { userStart: "2026-10-05" }), link("x", "b")), cal);
    expect(datesOf(schedule, "b")?.start).toBe("2026-10-05");
  });

  it("ignores a predecessor that no longer exists", () => {
    const schedule = computeSchedule(project(task("b", { userStart: "2026-10-05" }), link("gone", "b")), cal);
    expect(datesOf(schedule, "b")?.start).toBe("2026-10-05");
  });

  it("leaves locked tasks in place and flags the violation", () => {
    const b = [task("b", { userStart: "2026-10-06", locked: true }), link("a", "b")];
    const schedule = computeSchedule(project(a, ...b), cal);
    expect(datesOf(schedule, "b")?.start).toBe("2026-10-06");
    expect(schedule.get("b")?.violation).toBe(true);
  });

  it("does not flag a locked task that satisfies its rules", () => {
    const b = [task("b", { userStart: "2026-10-09", locked: true }), link("a", "b")];
    expect(computeSchedule(project(a, ...b), cal).get("b")?.violation).toBe(false);
  });
});

describe("computeSchedule — parents and sections", () => {
  it("rolls parent tasks and sections up from their children", () => {
    const schedule = computeSchedule(
      project(
        section("s"),
        task("p", { parentId: "s", userStart: "2026-01-01", duration: 50 }),
        task("c1", { parentId: "p", userStart: "2026-10-05", duration: 2 }),
        task("c2", { parentId: "p", userStart: "2026-10-08", duration: 3 }),
        task("u", { parentId: "s" }),
      ),
      cal,
    );
    expect(datesOf(schedule, "p")).toEqual({ start: "2026-10-05", end: "2026-10-12" });
    expect(datesOf(schedule, "s")).toEqual({ start: "2026-10-05", end: "2026-10-12" });
  });

  it("gives empty sections no dates", () => {
    expect(datesOf(computeSchedule(project(section("s")), cal), "s")).toBeNull();
  });

  it("pushes the children of a parent that has a predecessor", () => {
    const schedule = computeSchedule(
      project(
        task("a", { userStart: "2026-10-05", duration: 3 }),
        task("p"),
        link("a", "p"),
        task("c1", { parentId: "p", userStart: "2026-10-05" }),
        task("c2", { parentId: "p", userStart: "2026-10-12" }),
      ),
      cal,
    );
    expect(datesOf(schedule, "c1")?.start).toBe("2026-10-08");
    expect(datesOf(schedule, "c2")?.start).toBe("2026-10-12");
    expect(datesOf(schedule, "p")).toEqual({ start: "2026-10-08", end: "2026-10-12" });
  });

  it("uses a parent's rolled-up end when it is a predecessor", () => {
    const schedule = computeSchedule(
      project(
        task("p"),
        task("c1", { parentId: "p", userStart: "2026-10-05", duration: 4 }),
        task("b", { userStart: "2026-10-05" }),
        link("p", "b"),
      ),
      cal,
    );
    expect(datesOf(schedule, "b")?.start).toBe("2026-10-09");
  });
});

describe("computeSchedule — link kinds", () => {
  // June 2026: Mon 1, Tue 2, Wed 3, Thu 4, Fri 5, Sat 6, Sun 7, Mon 8 … Fri 12 … Tue 16
  const june = calendar({ timeOff: [{ id: "t1", resourceId: "bo", startDate: "2026-06-05", endDate: "2026-06-05" }] });
  const a = task("a", { userStart: "2026-06-01", duration: 5 }); // Mon 1 – Fri 5

  it("SS waits for the predecessor's start plus lag", () => {
    const schedule = computeSchedule(project(a, task("b", { userStart: "2026-06-01" }), link("a", "b", 2, "SS")), june);
    expect(datesOf(schedule, "b")?.start).toBe("2026-06-03");
  });

  it("FF ends the follower when the predecessor ends", () => {
    const schedule = computeSchedule(project(a, task("b", { userStart: "2026-06-01", duration: 2 }), link("a", "b", 0, "FF")), june);
    expect(datesOf(schedule, "b")).toEqual({ start: "2026-06-04", end: "2026-06-05" });
  });

  it("FF on the follower's own calendar", () => {
    const b = task("b", { userStart: "2026-06-01", duration: 2, resourceId: "bo" });
    const schedule = computeSchedule(project(a, b, link("a", "b", 0, "FF")), june);
    expect(datesOf(schedule, "b")?.end).toBe("2026-06-08");
  });

  it("FF adds its lag to the end", () => {
    const schedule = computeSchedule(project(a, task("b", { userStart: "2026-06-01", duration: 2 }), link("a", "b", 1, "FF")), june);
    expect(datesOf(schedule, "b")).toEqual({ start: "2026-06-05", end: "2026-06-08" });
  });

  it("the strictest of several links wins", () => {
    const schedule = computeSchedule(
      project(
        task("a1", { userStart: "2026-06-01", duration: 2 }), // ends Tue 2
        task("a2", { userStart: "2026-06-04", duration: 1 }), // starts Thu 4
        task("b", { userStart: "2026-06-01" }),
        link("a1", "b"),
        link("a2", "b", 0, "SS"),
      ),
      june,
    );
    expect(datesOf(schedule, "b")?.start).toBe("2026-06-04");
  });

  it("half days", () => {
    const halfA = task("a", { userStart: "2026-06-01", duration: 2.5 }); // ends at midday Wed 3
    const twoDays = computeSchedule(project(halfA, task("b", { userStart: "2026-06-01", duration: 2 }), link("a", "b", 0, "FF")), june);
    expect(halvesOf(twoDays, "b")).toEqual({ start: "2026-06-01 pm", end: "2026-06-03 am" });
    const oneAndHalf = computeSchedule(project(halfA, task("b", { userStart: "2026-06-01", duration: 1.5 }), link("a", "b", 0, "FF")), june);
    expect(halvesOf(oneAndHalf, "b")).toEqual({ start: "2026-06-02 am", end: "2026-06-03 am" });
  });

  it("FF into a milestone", () => {
    const schedule = computeSchedule(project(a, task("m", { userStart: "2026-06-01", duration: 0 }), link("a", "m", 0, "FF")), june);
    expect(datesOf(schedule, "m")).toEqual({ start: "2026-06-05", end: "2026-06-05" });
  });

  const parent = [
    task("p"),
    task("c1", { parentId: "p", userStart: "2026-06-01", duration: 3 }), // Mon 1 – Wed 3
    task("c2", { parentId: "p", userStart: "2026-06-02", duration: 2 }), // Tue 2 – Wed 3
    task("x", { userStart: "2026-06-08", duration: 5 }), // Mon 8 – Fri 12
    link("x", "p", 0, "FF"),
  ];

  it("FF onto a parent stretches it, not its subtasks; the section above follows the stretch", () => {
    const schedule = computeSchedule(project(section("s"), task("p", { parentId: "s" }), ...parent.slice(1)), june);
    expect(datesOf(schedule, "p")).toEqual({ start: "2026-06-01", end: "2026-06-12" });
    expect(datesOf(schedule, "s")).toEqual({ start: "2026-06-01", end: "2026-06-12" });
    expect(datesOf(schedule, "c1")).toEqual({ start: "2026-06-01", end: "2026-06-03" });
    expect(datesOf(schedule, "c2")).toEqual({ start: "2026-06-02", end: "2026-06-03" });
  });

  it("the stretch goes away when a subtask ends later", () => {
    const later = task("c3", { parentId: "p", userStart: "2026-06-15", duration: 2 }); // Mon 15 – Tue 16
    expect(datesOf(computeSchedule(project(...parent, later), june), "p")).toEqual({ start: "2026-06-01", end: "2026-06-16" });
  });

  it("FF onto a parent without scheduled subtasks leaves it unscheduled", () => {
    const state = project(task("p"), task("c", { parentId: "p" }), task("x", { userStart: "2026-06-08" }), link("x", "p", 0, "FF"));
    expect(datesOf(computeSchedule(state, june), "p")).toBeNull();
  });

  it("SS onto a parent pushes its subtasks", () => {
    const schedule = computeSchedule(
      project(
        task("x", { userStart: "2026-06-03", duration: 5 }),
        task("p"),
        link("x", "p", 1, "SS"),
        task("c1", { parentId: "p", userStart: "2026-06-01" }),
        task("c2", { parentId: "p", userStart: "2026-06-08" }),
      ),
      june,
    );
    expect(datesOf(schedule, "c1")?.start).toBe("2026-06-04");
    expect(datesOf(schedule, "c2")?.start).toBe("2026-06-08");
  });

  it("FF onto a parent does not push its subtasks", () => {
    const state = project(...parent);
    const c1 = state.rows.c1 as TaskRow;
    expect(constraintsFor(state, c1)).toEqual([]);
  });

  it("violatedLinks", () => {
    const state = project(
      task("a", { userStart: "2026-06-01", duration: 2 }), // Mon 1 – Tue 2
      task("c", { userStart: "2026-06-01", duration: 5 }), // Mon 1 – Fri 5
      task("b", { userStart: "2026-06-03", duration: 2, locked: true }), // Wed 3 – Thu 4
      link("a", "b"),
      link("c", "b", 0, "FF"),
    );
    const schedule = computeSchedule(state, june);
    expect(schedule.get("b")?.violation).toBe(true);
    expect(violatedLinks(state, june, schedule)).toEqual(new Set([linkKey(link("c", "b", 0, "FF"))]));
  });

  it("violatedLinks is empty when every locked task keeps its links", () => {
    const state = project(a, task("b", { userStart: "2026-06-01", locked: true }), link("a", "b", 0, "SS"));
    const schedule = computeSchedule(state, june);
    expect(schedule.get("b")?.violation).toBe(false);
    expect(violatedLinks(state, june, schedule).size).toBe(0);
  });
});

describe("cycles", () => {
  it("detects a direct cycle", () => {
    const state = project(
      task("a", { userStart: "2026-10-05" }),
      link("b", "a"),
      task("b", { userStart: "2026-10-05" }),
      link("a", "b"),
    );
    expect(() => computeSchedule(state, cal)).toThrow(CycleError);
    expect(hasCycle(state, cal)).toBe(true);
  });

  it("detects a child depending on its own parent", () => {
    const state = project(task("p"), task("c", { parentId: "p", userStart: "2026-10-05" }), link("p", "c"));
    expect(hasCycle(state, cal)).toBe(true);
  });

  it("detects a parent depending on its own child", () => {
    const state = project(task("p"), link("c", "p"), task("c", { parentId: "p", userStart: "2026-10-05" }));
    expect(hasCycle(state, cal)).toBe(true);
  });

  it("accepts a valid forest", () => {
    const state = project(
      task("a", { userStart: "2026-10-05" }),
      task("b", { userStart: "2026-10-05" }),
      link("a", "b"),
      task("c", { userStart: "2026-10-05" }),
      link("a", "c"),
    );
    expect(hasCycle(state, cal)).toBe(false);
  });

  it("detects cycles across kinds", () => {
    const state = project(task("a", { userStart: "2026-10-05" }), task("b", { userStart: "2026-10-05" }), link("a", "b"), link("b", "a", 0, "SS"));
    expect(() => computeSchedule(state, cal)).toThrow(CycleError);
  });

  it("detects cycles through an FF link into a parent", () => {
    const state = project(
      task("p"),
      task("c", { parentId: "p", userStart: "2026-10-05" }),
      task("x", { userStart: "2026-10-05" }),
      link("x", "p", 0, "FF"),
      link("p", "x"),
    );
    expect(() => computeSchedule(state, cal)).toThrow(CycleError);
  });

  it("detects cycles of three tasks", () => {
    const state = project(
      task("a", { userStart: "2026-10-05" }),
      link("c", "a"),
      task("b", { userStart: "2026-10-05" }),
      link("a", "b"),
      task("c", { userStart: "2026-10-05" }),
      link("b", "c"),
    );
    expect(hasCycle(state, cal)).toBe(true);
  });

  it("detects cycles through a parent's inherited constraint", () => {
    const state = project(
      task("x", { userStart: "2026-10-05" }),
      link("c", "x"),
      task("p"),
      link("x", "p"),
      task("c", { parentId: "p", userStart: "2026-10-05" }),
    );
    expect(hasCycle(state, cal)).toBe(true);
  });

  it("detects cycles through unscheduled tasks", () => {
    const bothUnscheduled = project(task("a"), link("b", "a"), task("b"), link("a", "b"));
    const oneUnscheduled = project(
      task("a", { userStart: "2026-10-05" }),
      link("b", "a"),
      task("b"),
      link("a", "b"),
    );
    const unscheduledChildOfOwnPredecessor = project(task("p"), task("c", { parentId: "p" }), link("p", "c"));
    expect(hasCycle(bothUnscheduled, cal)).toBe(true);
    expect(hasCycle(oneUnscheduled, cal)).toBe(true);
    expect(hasCycle(unscheduledChildOfOwnPredecessor, cal)).toBe(true);
  });
});

describe("constraintsFor", () => {
  it("terminates even if parent links are corrupted into a loop", () => {
    const state = project(
      task("c", { parentId: "a", userStart: "2026-10-05" }),
      task("a", { parentId: "b" }),
      link("x", "a"),
      task("b", { parentId: "a" }),
      task("x", { userStart: "2026-10-05" }),
    );
    const constraints = constraintsFor(state, state.rows.c as TaskRow);
    expect(constraints.length).toBeGreaterThan(0);
    expect(constraints.length).toBeLessThanOrEqual(Object.keys(state.rows).length);
    expect(hasCycle(state, cal)).toBe(true);
  });
});

describe("linkFloor", () => {
  // June 2026: a runs Mon 1 – Fri 5.
  const span = computeSchedule(project(task("a", { userStart: "2026-06-01", duration: 5 })), calendar()).get("a")!.span!;
  const follower = task("b", { duration: 2 });
  const morningOf = (date: string) => halfDay(toDay(date), false);

  it("is the day after the predecessor starts for FS, its start for SS, and the start that ends with it for FF", () => {
    expect(linkFloor(calendar(), follower, link("a", "b", 3), span)).toBe(morningOf("2026-06-02"));
    expect(linkFloor(calendar(), follower, link("a", "b", 3, "SS"), span)).toBe(morningOf("2026-06-01"));
    expect(linkFloor(calendar(), follower, link("a", "b", 3, "FF"), span)).toBe(morningOf("2026-06-04"));
  });
});

describe("isAncestor", () => {
  it("terminates even if parent links are corrupted into a loop", () => {
    const state = project(task("a", { parentId: "b" }), task("b", { parentId: "a" }));
    expect(isAncestor(state, "x", "a")).toBe(false);
  });
});
