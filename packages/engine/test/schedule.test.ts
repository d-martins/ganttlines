import { describe, expect, it } from "vitest";
import { computeSchedule, constraintsFor, CycleError, hasCycle } from "../src/schedule";
import type { TaskRow } from "../src/model";
import { isAncestor } from "../src/tree";
import { calendar, datesOf, project, section, task } from "./fixtures";

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
    const schedule = computeSchedule(project(a, task("b", { userStart: "2026-10-05", predecessorId: "a" })), cal);
    expect(datesOf(schedule, "b")?.start).toBe("2026-10-08");
  });

  it("keeps the user's later start", () => {
    const schedule = computeSchedule(project(a, task("b", { userStart: "2026-10-13", predecessorId: "a" })), cal);
    expect(datesOf(schedule, "b")?.start).toBe("2026-10-13");
  });

  it("allows overlap through a negative offset", () => {
    const b = task("b", { userStart: "2026-10-05", predecessorId: "a", offset: -2 });
    expect(datesOf(computeSchedule(project(a, b), cal), "b")?.start).toBe("2026-10-06");
  });

  it("never starts on or before the predecessor's start", () => {
    const b = task("b", { userStart: "2026-10-01", predecessorId: "a", offset: -10 });
    expect(datesOf(computeSchedule(project(a, b), cal), "b")?.start).toBe("2026-10-06");
  });

  it("adds a positive offset as a gap in working days", () => {
    const b = task("b", { userStart: "2026-10-05", predecessorId: "a", offset: 2 });
    expect(datesOf(computeSchedule(project(a, b), cal), "b")?.start).toBe("2026-10-12");
  });

  it("measures the successor's rules on the successor's own calendar", () => {
    const b = task("b", { userStart: "2026-10-05", predecessorId: "a", resourceId: "ana" });
    // natural day after Wed 7 is Thu 8, but Ana is off Thu 8 → Fri 9
    expect(datesOf(computeSchedule(project(a, b), cal), "b")?.start).toBe("2026-10-09");
  });

  it("chains pushes through several tasks", () => {
    const schedule = computeSchedule(
      project(
        a,
        task("b", { userStart: "2026-10-05", predecessorId: "a", duration: 2 }),
        task("c", { userStart: "2026-10-05", predecessorId: "b" }),
      ),
      cal,
    );
    expect(datesOf(schedule, "c")?.start).toBe("2026-10-12");
  });

  it("ignores unscheduled predecessors", () => {
    const schedule = computeSchedule(project(task("x"), task("b", { userStart: "2026-10-05", predecessorId: "x" })), cal);
    expect(datesOf(schedule, "b")?.start).toBe("2026-10-05");
  });

  it("ignores a predecessor that no longer exists", () => {
    const schedule = computeSchedule(project(task("b", { userStart: "2026-10-05", predecessorId: "gone" })), cal);
    expect(datesOf(schedule, "b")?.start).toBe("2026-10-05");
  });

  it("leaves locked tasks in place and flags the violation", () => {
    const b = task("b", { userStart: "2026-10-06", predecessorId: "a", locked: true });
    const schedule = computeSchedule(project(a, b), cal);
    expect(datesOf(schedule, "b")?.start).toBe("2026-10-06");
    expect(schedule.get("b")?.violation).toBe(true);
  });

  it("does not flag a locked task that satisfies its rules", () => {
    const b = task("b", { userStart: "2026-10-09", predecessorId: "a", locked: true });
    expect(computeSchedule(project(a, b), cal).get("b")?.violation).toBe(false);
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
        task("p", { predecessorId: "a" }),
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
        task("b", { userStart: "2026-10-05", predecessorId: "p" }),
      ),
      cal,
    );
    expect(datesOf(schedule, "b")?.start).toBe("2026-10-09");
  });
});

describe("cycles", () => {
  it("detects a direct cycle", () => {
    const state = project(
      task("a", { userStart: "2026-10-05", predecessorId: "b" }),
      task("b", { userStart: "2026-10-05", predecessorId: "a" }),
    );
    expect(() => computeSchedule(state, cal)).toThrow(CycleError);
    expect(hasCycle(state, cal)).toBe(true);
  });

  it("detects a child depending on its own parent", () => {
    const state = project(task("p"), task("c", { parentId: "p", userStart: "2026-10-05", predecessorId: "p" }));
    expect(hasCycle(state, cal)).toBe(true);
  });

  it("detects a parent depending on its own child", () => {
    const state = project(task("p", { predecessorId: "c" }), task("c", { parentId: "p", userStart: "2026-10-05" }));
    expect(hasCycle(state, cal)).toBe(true);
  });

  it("accepts a valid forest", () => {
    const state = project(
      task("a", { userStart: "2026-10-05" }),
      task("b", { userStart: "2026-10-05", predecessorId: "a" }),
      task("c", { userStart: "2026-10-05", predecessorId: "a" }),
    );
    expect(hasCycle(state, cal)).toBe(false);
  });

  it("detects cycles of three tasks", () => {
    const state = project(
      task("a", { userStart: "2026-10-05", predecessorId: "c" }),
      task("b", { userStart: "2026-10-05", predecessorId: "a" }),
      task("c", { userStart: "2026-10-05", predecessorId: "b" }),
    );
    expect(hasCycle(state, cal)).toBe(true);
  });

  it("detects cycles through a parent's inherited constraint", () => {
    const state = project(
      task("x", { userStart: "2026-10-05", predecessorId: "c" }),
      task("p", { predecessorId: "x" }),
      task("c", { parentId: "p", userStart: "2026-10-05" }),
    );
    expect(hasCycle(state, cal)).toBe(true);
  });

  it("detects cycles through unscheduled tasks", () => {
    const bothUnscheduled = project(task("a", { predecessorId: "b" }), task("b", { predecessorId: "a" }));
    const oneUnscheduled = project(
      task("a", { userStart: "2026-10-05", predecessorId: "b" }),
      task("b", { predecessorId: "a" }),
    );
    const unscheduledChildOfOwnPredecessor = project(task("p"), task("c", { parentId: "p", predecessorId: "p" }));
    expect(hasCycle(bothUnscheduled, cal)).toBe(true);
    expect(hasCycle(oneUnscheduled, cal)).toBe(true);
    expect(hasCycle(unscheduledChildOfOwnPredecessor, cal)).toBe(true);
  });
});

describe("constraintsFor", () => {
  it("terminates even if parent links are corrupted into a loop", () => {
    const state = project(
      task("c", { parentId: "a", userStart: "2026-10-05" }),
      task("a", { parentId: "b", predecessorId: "x" }),
      task("b", { parentId: "a" }),
      task("x", { userStart: "2026-10-05" }),
    );
    const constraints = constraintsFor(state, state.rows.c as TaskRow);
    expect(constraints.length).toBeGreaterThan(0);
    expect(constraints.length).toBeLessThanOrEqual(Object.keys(state.rows).length);
    expect(hasCycle(state, cal)).toBe(true);
  });
});

describe("isAncestor", () => {
  it("terminates even if parent links are corrupted into a loop", () => {
    const state = project(task("a", { parentId: "b" }), task("b", { parentId: "a" }));
    expect(isAncestor(state, "x", "a")).toBe(false);
  });
});
