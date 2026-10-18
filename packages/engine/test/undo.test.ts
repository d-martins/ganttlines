import { describe, expect, it } from "vitest";
import { diffState, linkKey, revertChanges, TASK_DEFAULTS, type Change, type Link, type ProjectState, type TaskRow } from "../src";

const task = (id: string, fields: Partial<TaskRow> = {}): TaskRow => ({
  ...TASK_DEFAULTS,
  id,
  kind: "task",
  title: id,
  parentId: null,
  position: "a0",
  ...fields,
});
const state = (...rows: TaskRow[]): ProjectState => ({ rows: Object.fromEntries(rows.map((row) => [row.id, row])), links: {} });
const withLinks = (base: ProjectState, ...links: Link[]): ProjectState => ({
  ...base,
  links: { ...base.links, ...Object.fromEntries(links.map((link) => [linkKey(link), link])) },
});
const link = (predecessorId: string, followerId: string, kind: Link["kind"] = "FS", lag = 0): Link => ({ predecessorId, followerId, kind, lag });

describe("revertChanges", () => {
  it("restores changed fields on undo and re-applies them on redo", () => {
    const before = state(task("a", { title: "Old" }));
    const after = state(task("a", { title: "New" }));
    const changes = diffState(before, after);
    const undone = revertChanges(after, changes, "undo");
    expect(undone).toEqual({ state: before, skipped: 0 });
    expect(revertChanges(undone.state, changes, "redo")).toEqual({ state: after, skipped: 0 });
  });

  it("leaves fields alone that someone changed since (skip-on-conflict)", () => {
    const before = state(task("a", { title: "Old", duration: 1 }));
    const after = state(task("a", { title: "New", duration: 2 }));
    const changes = diffState(before, after);
    const edited = state(task("a", { title: "Theirs", duration: 2 }));
    expect(revertChanges(edited, changes, "undo")).toEqual({ state: state(task("a", { title: "Theirs", duration: 1 })), skipped: 1 });
  });

  it("removes created rows on undo, unless they changed or something points at them", () => {
    const created = diffState(state(), state(task("a")));
    expect(revertChanges(state(task("a")), created, "undo")).toEqual({ state: state(), skipped: 0 });
    expect(revertChanges(state(task("a", { title: "Edited" })), created, "undo").skipped).toBe(1);
    const withChild = state(task("a"), task("b", { parentId: "a" }));
    expect(revertChanges(withChild, created, "undo")).toEqual({ state: withChild, skipped: 1 });
  });

  it("re-creates deleted rows on undo, unless they exist again", () => {
    const deleted = diffState(state(task("a")), state());
    expect(revertChanges(state(), deleted, "undo")).toEqual({ state: state(task("a")), skipped: 0 });
    expect(revertChanges(state(task("a", { title: "Back" })), deleted, "undo").skipped).toBe(1);
  });

  it("matches rows whatever order their fields come back in (e.g. read from storage)", () => {
    const created = diffState(state(), state(task("a")));
    const reordered = Object.fromEntries(Object.entries(task("a")).reverse()) as TaskRow;
    expect(revertChanges(state(reordered), created, "undo")).toEqual({ state: state(), skipped: 0 });
  });

  describe("links", () => {
    const rows = state(task("A"), task("B"), task("C"));

    it("undo removes a link it created, but keeps one someone else added since", () => {
      const alice = diffState(rows, withLinks(rows, link("A", "C")));
      const now = withLinks(rows, link("A", "C"), link("B", "C", "SS"));
      const undone = revertChanges(now, alice, "undo");
      expect(undone).toEqual({ state: withLinks(rows, link("B", "C", "SS")), skipped: 0 });
      expect(Object.keys(undone.state.links)).not.toContain(linkKey(link("A", "C")));
    });

    it("undo of a lag change is skipped once someone changed that lag again", () => {
      const changes = diffState(withLinks(rows, link("A", "B")), withLinks(rows, link("A", "B", "FS", -1)));
      expect(revertChanges(withLinks(rows, link("A", "B", "FS", -1)), changes, "undo")).toEqual({ state: withLinks(rows, link("A", "B")), skipped: 0 });
      const theirs = withLinks(rows, link("A", "B", "FS", 2));
      expect(revertChanges(theirs, changes, "undo")).toEqual({ state: theirs, skipped: 1 });
    });

    it("a re-created link whose task was deleted since is dropped and counted as skipped", () => {
      const removed = diffState(withLinks(rows, link("A", "B")), rows);
      const withoutB = state(task("A"), task("C"));
      expect(revertChanges(withoutB, removed, "undo")).toEqual({ state: withoutB, skipped: 1 });
    });

    it("a row kept by undo because a remaining link points to it", () => {
      const created = diffState(state(task("Y")), state(task("Y"), task("X")));
      const now = withLinks(state(task("Y"), task("X")), link("X", "Y"));
      expect(revertChanges(now, created, "undo")).toEqual({ state: now, skipped: 1 });
    });

    it("old logged changes to fields rows no longer have are skipped", () => {
      const old: Change[] = [{ rowId: "B", field: "predecessorId", before: null, after: "A" }];
      const undone = revertChanges(rows, old, "undo");
      expect(Object.hasOwn(undone.state.rows.B!, "predecessorId")).toBe(false);
      expect(undone.skipped).toBe(1);
      expect(revertChanges(rows, old, "redo").skipped).toBe(1);
    });
  });
});
