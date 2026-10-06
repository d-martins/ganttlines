import { describe, expect, it } from "vitest";
import { findTreeProblem, TASK_DEFAULTS, type Row } from "../src";

const SECTION_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const rows: Row[] = [
  { id: SECTION_ID, kind: "section", title: "Phase 1", parentId: null, position: "a0" },
  { ...TASK_DEFAULTS, id: TASK_ID, kind: "task", title: "Build", parentId: SECTION_ID, position: "a0", userStart: "2026-10-05", duration: 3 },
];

describe("findTreeProblem", () => {
  it("accepts a valid tree", () => {
    expect(findTreeProblem(rows)).toBeNull();
  });

  it("detects missing predecessors", () => {
    const [, task] = rows as [Row, Row];
    expect(findTreeProblem([rows[0]!, { ...task, predecessorId: "33333333-3333-4333-8333-333333333333" } as Row])).toMatch(/missing predecessor/);
  });

  it("detects missing parents, parent loops and sections inside tasks", () => {
    const [section, task] = rows as [Row, Row];
    expect(findTreeProblem([task])).toMatch(/missing parent/);
    expect(findTreeProblem([{ ...section, parentId: task.id }, task])).toMatch(/section .* is inside task|loop/);
    expect(findTreeProblem([{ ...task, parentId: TASK_ID }])).toMatch(/loop/);
  });
});
