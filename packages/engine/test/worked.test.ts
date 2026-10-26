import { describe, expect, it } from "vitest";
import { computeSchedule } from "../src/schedule";
import { workedDays, workedDaysOfAll } from "../src/worked";
import type { Row } from "../src/model";
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

  it("an unscheduled subtask adds nothing; a parent or section without leaf tasks shows 0", () => {
    const state = project(
      task("p"),
      task("c", { parentId: "p", userStart: "2026-10-05", duration: 2 }),
      task("u", { parentId: "p", duration: 3 }), // unscheduled
      section("s"),
      section("inner", { parentId: "s" }),
      task("q", { parentId: "s" }),
      task("m", { parentId: "q", userStart: "2026-10-05", duration: 0 }), // only a milestone
    );
    const schedule = computeSchedule(state, cal);
    expect(workedDays(state, schedule, cal, "p")).toBe(2);
    expect(workedDays(state, schedule, cal, "q")).toBe(0);
    expect(workedDays(state, schedule, cal, "inner")).toBe(0);
    expect(Object.fromEntries(workedDaysOfAll(state, schedule, cal))).toEqual({ p: 2, s: 0, inner: 0, q: 0 });
  });

  it("workedDaysOfAll gives every parent and section the same count as workedDays, in one pass", () => {
    // A generated board: sections, nested parents and leaves on varied days and people.
    let seed = 7;
    const next = (n: number) => ((seed = (seed * 48271) % 2147483647), seed % n);
    const rows: Row[] = [];
    for (let i = 0; i < 300; i++) {
      const parents = rows.filter((row) => row.kind === "section" || (row.kind === "task" && row.userStart === null));
      const parentId = parents.length && next(4) ? parents[next(parents.length)]!.id : null;
      const kind = next(10);
      if (kind === 0 && rows.every((row) => row.id !== parentId || row.kind === "section")) rows.push(section(`s${i}`, { parentId }));
      else if (kind < 3) rows.push(task(`p${i}`, { parentId }));
      else {
        const day = String(1 + next(28)).padStart(2, "0");
        rows.push(task(`t${i}`, { parentId, resourceId: next(2) ? "ana" : null, userStart: next(8) ? `2026-10-${day}` : null, duration: next(6) * 0.5 }));
      }
    }
    const state = project(...rows);
    const schedule = computeSchedule(state, cal);
    const all = workedDaysOfAll(state, schedule, cal);
    const expected = new Map<string, number>();
    for (const row of Object.values(state.rows)) {
      const isLeaf = row.kind === "task" && !Object.values(state.rows).some((child) => child.parentId === row.id && child.kind === "task");
      if (!isLeaf) expected.set(row.id, workedDays(state, schedule, cal, row.id));
    }
    expect(expected.size).toBeGreaterThan(50);
    expect([...expected.values()].some((n) => n > 5)).toBe(true);
    expect(new Map([...all].sort())).toEqual(new Map([...expected].sort()));
  });
});
