import { describe, expect, it } from "vitest";
import type { Calendar } from "../src/calendar";
import type { ProjectState, TaskRow } from "../src/model";
import { computeSchedule } from "../src/schedule";
import { calendar, datesOf, EVERY_DAY, MON_FRI, project, task } from "./fixtures";
import { run } from "./helpers";

function startOf(state: ProjectState, cal: Calendar, id: string): string | undefined {
  return datesOf(computeSchedule(state, cal), id)?.start;
}

function offsetOf(state: ProjectState, id: string): number {
  return (state.rows[id] as TaskRow).offset;
}

/** The dependency rules, step by step (every day is a working day). */
describe("dependency walkthrough", () => {
  const cal = calendar({ workingWeekdays: EVERY_DAY });
  const endA = (day: number) => ({ type: "resizeTask", id: "a", edge: "end", date: `2026-10-${String(day).padStart(2, "0")}` }) as const;
  const moveB = (day: number) => ({ type: "moveTask", id: "b", start: `2026-10-${String(day).padStart(2, "0")}` }) as const;

  it("follows the eight steps", () => {
    let state = project(
      task("a", { userStart: "2026-10-04", duration: 7 }),
      task("b", { userStart: "2026-10-11", duration: 2, predecessorId: "a" }),
    );
    const steps: [ReturnType<typeof endA> | ReturnType<typeof moveB>, string, number][] = [
      [moveB(15), "2026-10-15", 0],
      [endA(16), "2026-10-17", 0],
      [endA(11), "2026-10-15", 0],
      [moveB(9), "2026-10-09", -3],
      [endA(16), "2026-10-14", -3],
      [endA(5), "2026-10-09", -3],
      [moveB(10), "2026-10-10", 0],
      [endA(12), "2026-10-13", 0],
    ];
    for (const [command, expectedStart, expectedOffset] of steps) {
      state = run(state, cal, command);
      expect({ step: command, start: startOf(state, cal, "b"), offset: offsetOf(state, "b") }).toEqual({
        step: command,
        start: expectedStart,
        offset: expectedOffset,
      });
    }
  });

  it("counts offsets in working days across weekends", () => {
    const weekdays = calendar({ workingWeekdays: MON_FRI });
    let state = project(
      task("a", { userStart: "2026-10-05", duration: 3 }), // Mon 5 – Wed 7
      task("b", { userStart: "2026-10-08", predecessorId: "a" }),
    );
    state = run(state, weekdays, { type: "moveTask", id: "b", start: "2026-10-06" });
    expect(offsetOf(state, "b")).toBe(-2);
    state = run(state, weekdays, { type: "resizeTask", id: "a", edge: "end", date: "2026-10-09" }); // ends Fri 9
    expect(startOf(state, weekdays, "b")).toBe("2026-10-08"); // Mon 12 − 2 working days
  });
});
