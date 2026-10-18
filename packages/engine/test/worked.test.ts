import { describe, expect, it } from "vitest";
import { computeSchedule } from "../src/schedule";
import { workedDays } from "../src/worked";
import { calendar, datesOf, link, project, section, task } from "./fixtures";

// October 2026: Mon 5 … Fri 9, Mon 12 … Wed 14. Ana is off Wed 7 – Fri 9.
const cal = calendar({ timeOff: [{ id: "t1", resourceId: "ana", startDate: "2026-10-07", endDate: "2026-10-09" }] });

describe("workedDays", () => {
  it("a parent over the 5th–14th whose only subtask's assignee is off 3 days shows 5, not 8", () => {
    const state = project(task("p"), task("c", { parentId: "p", resourceId: "ana", userStart: "2026-10-05", duration: 5 }));
    const schedule = computeSchedule(state, cal);
    expect(datesOf(schedule, "p")).toEqual({ start: "2026-10-05", end: "2026-10-14" });
    expect(workedDays(state, schedule, cal, "p")).toBe(5);
  });

  it("two subtasks on overlapping days count each day once", () => {
    const state = project(
      task("p"),
      task("a", { parentId: "p", userStart: "2026-10-05", duration: 3 }), // Mon 5 – Wed 7
      task("b", { parentId: "p", userStart: "2026-10-06", duration: 3 }), // Tue 6 – Thu 8
    );
    expect(workedDays(state, computeSchedule(state, cal), cal, "p")).toBe(4);
  });

  it("half days count as whole days", () => {
    const state = project(task("p"), task("c", { parentId: "p", userStart: "2026-10-05", duration: 1.5 }));
    expect(workedDays(state, computeSchedule(state, cal), cal, "p")).toBe(2);
  });

  it("an FF stretch adds no days", () => {
    const state = project(
      task("p"),
      task("c", { parentId: "p", userStart: "2026-10-05", duration: 2 }), // Mon 5 – Tue 6
      task("x", { userStart: "2026-10-05", duration: 8 }), // Mon 5 – Wed 14
      link("x", "p", 0, "FF"),
    );
    const schedule = computeSchedule(state, cal);
    expect(datesOf(schedule, "p")).toEqual({ start: "2026-10-05", end: "2026-10-14" });
    expect(workedDays(state, schedule, cal, "p")).toBe(2);
  });

  it("a section counts its tasks the same way", () => {
    const state = project(
      section("s"),
      task("p", { parentId: "s" }),
      task("c", { parentId: "p", resourceId: "ana", userStart: "2026-10-05", duration: 5 }), // Mon 5 – Wed 14, off 7–9
      task("d", { parentId: "s", userStart: "2026-10-12", duration: 1 }), // Mon 12, already counted
      task("m", { parentId: "s", userStart: "2026-10-16", duration: 0 }), // a milestone is no work
    );
    expect(workedDays(state, computeSchedule(state, cal), cal, "s")).toBe(5);
  });
});
