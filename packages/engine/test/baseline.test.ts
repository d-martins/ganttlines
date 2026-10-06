import { describe, expect, it } from "vitest";
import { baselineTasks, Calendar, TASK_DEFAULTS, type ProjectState, type Row } from "../src";

const calendar = new Calendar({ workingWeekdays: [1, 2, 3, 4, 5], holidays: [], timeOff: [] });
const rows: Row[] = [
  { id: "s", kind: "section", title: "Phase", parentId: null, position: "a0" },
  { ...TASK_DEFAULTS, id: "a", kind: "task", title: "Design", parentId: "s", position: "a0", userStart: "2026-10-05", duration: 2 },
  { ...TASK_DEFAULTS, id: "m", kind: "task", title: "Go", parentId: "s", position: "a1", userStart: "2026-10-09", duration: 0 },
];
const state: ProjectState = { rows: Object.fromEntries(rows.map((row) => [row.id, row])) };

describe("baselineTasks", () => {
  it("saves every scheduled task's dates and shape, leaving sections out", () => {
    const tasks = baselineTasks(state, calendar);
    expect(tasks.map((task) => task.rowId).sort()).toEqual(["a", "m"]);
    expect(tasks.find((task) => task.rowId === "a")).toEqual({
      rowId: "a",
      kind: "task",
      title: "Design",
      start: "2026-10-05",
      end: "2026-10-06",
      startsAfternoon: false,
      endsMidday: false,
    });
    expect(tasks.find((task) => task.rowId === "m")).toMatchObject({ kind: "milestone", title: "Go" });
  });
});
