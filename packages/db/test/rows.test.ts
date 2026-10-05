import { describe, expect, it } from "vitest";
import { TASK_DEFAULTS, type SectionRow, type TaskRow } from "@ganttlines/engine";
import { toDbColumns, toEngineRow } from "../src/rows";

const section: SectionRow = { id: "11111111-1111-4111-8111-111111111111", kind: "section", title: "Phase", parentId: null, position: "a0" };
const task: TaskRow = {
  ...TASK_DEFAULTS,
  id: "22222222-2222-4222-8222-222222222222",
  kind: "task",
  title: "Build",
  parentId: section.id,
  position: "a0",
  userStart: "2026-10-05",
  duration: 3,
  resourceId: "33333333-3333-4333-8333-333333333333",
  color: "purple",
  locked: true,
  predecessorId: "44444444-4444-4444-8444-444444444444",
  offset: -2,
  description: "notes",
};
const projectId = "55555555-5555-4555-8555-555555555555";

describe("row mapping", () => {
  it("round-trips tasks and sections", () => {
    for (const row of [section, task]) {
      expect(toEngineRow({ ...toDbColumns(row), projectId })).toEqual(row);
    }
  });

  it("stores task-column defaults for sections", () => {
    expect(toDbColumns(section)).toMatchObject({ userStart: null, duration: 1, color: "blue", predecessorId: null, offset: 0 });
  });

  it("rejects corrupted kinds and colors", () => {
    expect(() => toEngineRow({ ...toDbColumns(task), projectId, kind: "epic" })).toThrow(/unknown kind/);
    expect(() => toEngineRow({ ...toDbColumns(task), projectId, color: "plaid" })).toThrow(/unknown color/);
  });
});
