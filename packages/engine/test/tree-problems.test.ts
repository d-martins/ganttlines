import { describe, expect, it } from "vitest";
import { findLinkProblem, findTreeProblem, TASK_DEFAULTS, type Link, type Row } from "../src";

const SECTION_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const rows: Row[] = [
  { id: SECTION_ID, kind: "section", title: "Phase 1", parentId: null, position: "a0", description: "" },
  { ...TASK_DEFAULTS, id: TASK_ID, kind: "task", title: "Build", parentId: SECTION_ID, position: "a0", userStart: "2026-10-05", duration: 3 },
];

describe("findTreeProblem", () => {
  it("accepts a valid tree", () => {
    expect(findTreeProblem(rows)).toBeNull();
  });

  it("detects missing parents, parent loops and sections inside tasks", () => {
    const [section, task] = rows as [Row, Row];
    expect(findTreeProblem([task])).toMatch(/missing parent/);
    expect(findTreeProblem([{ ...section, parentId: task.id }, task])).toMatch(/section .* is inside task|loop/);
    expect(findTreeProblem([{ ...task, parentId: TASK_ID }])).toMatch(/loop/);
  });
});

describe("findLinkProblem", () => {
  const task = (id: string, parentId: string | null = null): Row => ({ ...TASK_DEFAULTS, id, kind: "task", title: id, parentId, position: "a0" });
  const tasks: Row[] = [task("a"), task("b"), task("p"), task("c", "p"), { id: "s", kind: "section", title: "S", parentId: null, position: "a1", description: "" }];
  const link = (predecessorId: string, followerId: string, kind: Link["kind"] = "FS", lag = 0): Link => ({ predecessorId, followerId, kind, lag });

  it("accepts valid links", () => {
    expect(findLinkProblem(tasks, [link("a", "b", "FS", -2), link("a", "b", "SS", 1.5), link("p", "a", "FF"), link("b", "a", "SF", 2.5)])).toBeNull();
  });

  it.each([
    ["a missing predecessor", [link("x", "b")]],
    ["a follower that is a section", [link("a", "s")]],
    ["a link to self", [link("a", "a")]],
    ["a link from a task to its parent", [link("c", "p")]],
    ["a link from a parent to its subtask", [link("p", "c")]],
    ["an SS lag of −1", [link("a", "b", "SS", -1)]],
    ["an FF lag of −1", [link("a", "b", "FF", -1)]],
    ["an SF lag of −0.5", [link("a", "b", "SF", -0.5)]],
    ["a lag of 0.25", [link("a", "b", "FS", 0.25)]],
    ["a lag beyond the limit", [link("a", "b", "FS", 3661)]],
    ["an unknown kind", [link("a", "b", "XX" as Link["kind"])]],
  ])("reports %s", (_, links) => {
    expect(findLinkProblem(tasks, links)).toEqual(expect.any(String));
  });

  it("terminates even if parent links are corrupted into a loop", () => {
    expect(findLinkProblem([task("x", "y"), task("y", "x"), task("z")], [link("z", "x")])).toBeNull();
  });

  it("reports 51 links into one task", () => {
    const many = Array.from({ length: 51 }, (_, i) => task(`t${i}`));
    const links = many.map((row) => link(row.id, "b"));
    expect(findLinkProblem([...tasks, ...many], links.slice(0, 50))).toBeNull();
    expect(findLinkProblem([...tasks, ...many], links)).toEqual(expect.any(String));
  });
});
