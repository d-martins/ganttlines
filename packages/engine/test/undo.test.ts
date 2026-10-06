import { describe, expect, it } from "vitest";
import { diffRows, revertChanges, TASK_DEFAULTS, type ProjectState, type TaskRow } from "../src";

const task = (id: string, fields: Partial<TaskRow> = {}): TaskRow => ({
  ...TASK_DEFAULTS,
  id,
  kind: "task",
  title: id,
  parentId: null,
  position: "a0",
  ...fields,
});
const state = (...rows: TaskRow[]): ProjectState => ({ rows: Object.fromEntries(rows.map((row) => [row.id, row])) });

describe("revertChanges", () => {
  it("restores changed fields on undo and re-applies them on redo", () => {
    const before = state(task("a", { title: "Old" }));
    const after = state(task("a", { title: "New" }));
    const changes = diffRows(before, after);
    const undone = revertChanges(after, changes, "undo");
    expect(undone).toEqual({ state: before, skipped: 0 });
    expect(revertChanges(undone.state, changes, "redo")).toEqual({ state: after, skipped: 0 });
  });

  it("leaves fields alone that someone changed since (skip-on-conflict)", () => {
    const before = state(task("a", { title: "Old", duration: 1 }));
    const after = state(task("a", { title: "New", duration: 2 }));
    const changes = diffRows(before, after);
    const edited = state(task("a", { title: "Theirs", duration: 2 }));
    expect(revertChanges(edited, changes, "undo")).toEqual({ state: state(task("a", { title: "Theirs", duration: 1 })), skipped: 1 });
  });

  it("removes created rows on undo, unless they changed or something points at them", () => {
    const created = diffRows(state(), state(task("a")));
    expect(revertChanges(state(task("a")), created, "undo")).toEqual({ state: state(), skipped: 0 });
    expect(revertChanges(state(task("a", { title: "Edited" })), created, "undo").skipped).toBe(1);
    const withChild = state(task("a"), task("b", { parentId: "a" }));
    expect(revertChanges(withChild, created, "undo")).toEqual({ state: withChild, skipped: 1 });
  });

  it("re-creates deleted rows on undo, unless they exist again", () => {
    const deleted = diffRows(state(task("a")), state());
    expect(revertChanges(state(), deleted, "undo")).toEqual({ state: state(task("a")), skipped: 0 });
    expect(revertChanges(state(task("a", { title: "Back" })), deleted, "undo").skipped).toBe(1);
  });

  it("matches rows whatever order their fields come back in (e.g. read from storage)", () => {
    const created = diffRows(state(), state(task("a")));
    const reordered = Object.fromEntries(Object.entries(task("a")).reverse()) as TaskRow;
    expect(revertChanges(state(reordered), created, "undo")).toEqual({ state: state(), skipped: 0 });
  });
});
