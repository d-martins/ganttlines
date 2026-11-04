import { describe, expect, it } from "vitest";
import { applyCommand, isValidTarget, type Command } from "../src/commands";
import type { ProjectState, TaskRow } from "../src/model";
import { computeSchedule } from "../src/schedule";

import { revertChanges } from "../src/undo";
import { calendar, project, section, task } from "./fixtures";
import { run } from "./helpers";

const cal = calendar();
const taskIn = (state: ProjectState, id: string) => state.rows[id] as TaskRow;
const dated = { userStart: "2026-10-05" } as const;
const board = () =>
  project(
    task("t", dated),
    task("other", dated),
    task("m", { userStart: "2026-10-16", duration: 0 }),
    task("plain", dated),
    task("parent", dated),
    task("kid", { ...dated, parentId: "parent" }),
    section("s"),
  );
const aimed = () => run(board(), cal, { type: "setTarget", id: "t", targetId: "m" }, { type: "setTarget", id: "other", targetId: "m" });
function undoOf(state: ProjectState, command: Command): { after: ProjectState; undone: ProjectState } {
  const result = applyCommand(state, cal, command);
  if (!result.ok) throw new Error(result.message);
  return { after: result.state, undone: revertChanges(result.state, result.changes, "undo").state };
}

describe("setTarget", () => {
  it("aims a task and changes nothing else", () => {
    const before = board();
    const result = applyCommand(before, cal, { type: "setTarget", id: "t", targetId: "m" });
    if (!result.ok) throw new Error(result.message);
    expect(result.changes).toEqual([{ rowId: "t", field: "targetId", before: null, after: "m" }]);
    expect(computeSchedule(result.state, cal)).toEqual(computeSchedule(before, cal));
  });

  it("clears with null, and a parent can aim", () => {
    const state = run(aimed(), cal, { type: "setTarget", id: "t", targetId: null }, { type: "setTarget", id: "parent", targetId: "m" });
    expect(taskIn(state, "t").targetId).toBeNull();
    expect(taskIn(state, "parent").targetId).toBe("m");
  });

  it.each([
    ["a normal task", "t", "plain"],
    ["a parent", "t", "parent"],
    ["a section", "t", "s"],
    ["an unknown id", "t", "nope"],
    ["itself", "m", "m"],
    ["from a milestone", "m", "m"],
    ["from a section", "s", "m"],
  ])("refuses %s", (_name, id, targetId) => {
    expect(applyCommand(board(), cal, { type: "setTarget", id, targetId })).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("knows what can be a target", () => {
    expect(isValidTarget(board(), "m")).toBe(true);
    for (const id of ["plain", "parent", "s", "nope"]) expect(isValidTarget(board(), id)).toBe(false);
  });
});

describe("createTargetMilestone", () => {
  const command: Command = { type: "createTargetMilestone", id: "t", newId: "new", title: "8.12", parentId: "s", afterId: null, start: "2026-10-20" };

  it("creates the milestone and aims at it", () => {
    const state = run(board(), cal, command);
    expect(taskIn(state, "new")).toMatchObject({ title: "8.12", duration: 0, parentId: "s", userStart: "2026-10-20" });
    expect(taskIn(state, "t").targetId).toBe("new");
  });

  it("is one undo step", () => {
    const before = board();
    expect(undoOf(before, command).undone).toEqual(before);
  });

  it("refuses from a milestone, and an id already used", () => {
    expect(applyCommand(board(), cal, { ...command, id: "m" } as Command)).toMatchObject({ ok: false, reason: "invalid" });
    expect(applyCommand(board(), cal, { ...command, newId: "m" } as Command)).toMatchObject({ ok: false, reason: "invalid" });
  });
});

describe("a target going away", () => {
  it("deleting a milestone clears its targets, and undo brings them back", () => {
    const before = aimed();
    const { after, undone } = undoOf(before, { type: "deleteRows", ids: ["m"] });
    expect(taskIn(after, "t").targetId).toBeNull();
    expect(taskIn(after, "other").targetId).toBeNull();
    expect(undone).toEqual(before);
  });

  it("deleting the section around it does too", () => {
    const start = run(board(), cal, { type: "moveRow", id: "m", parentId: "s", afterId: null }, { type: "setTarget", id: "t", targetId: "m" });
    expect(taskIn(run(start, cal, { type: "deleteRows", ids: ["s"] }), "t").targetId).toBeNull();
  });

  it("converting the milestone to a task clears targets on it, undoably", () => {
    const before = aimed();
    const { after, undone } = undoOf(before, { type: "convertMilestone", id: "m", milestone: false });
    expect(taskIn(after, "t").targetId).toBeNull();
    expect(undone).toEqual(before);
  });

  it("setting its working days does too", () => {
    expect(taskIn(run(aimed(), cal, { type: "setDuration", id: "m", duration: 2 }), "t").targetId).toBeNull();
  });

  it("an aiming task becoming a milestone loses its own target", () => {
    expect(taskIn(run(aimed(), cal, { type: "convertMilestone", id: "t", milestone: true }), "t").targetId).toBeNull();
  });

  it.each<[string, Command]>([
    ["createRow under it", { type: "createRow", id: "n", kind: "task", parentId: "m", afterId: null, title: "n" }],
    ["moveRow under it", { type: "moveRow", id: "plain", parentId: "m", afterId: null }],
  ])("a milestone gaining subtasks clears targets on it: %s", (_name, command) => {
    expect(taskIn(run(aimed(), cal, command), "t").targetId).toBeNull();
  });

  it("a milestone gaining subtasks by indent clears targets on it", () => {
    const state = project(task("t", { ...dated, targetId: "m" }), task("m", { userStart: "2026-10-16", duration: 0 }), task("x", dated));
    expect(taskIn(run(state, cal, { type: "indent", id: "x" }), "t").targetId).toBeNull();
  });
});

describe("the rest", () => {
  it("duplicating keeps the target", () => {
    expect(taskIn(run(aimed(), cal, { type: "duplicateTask", id: "t", newId: "copy" }), "copy").targetId).toBe("m");
  });

  it("createRow can make a milestone, and refuses that for a section", () => {
    const state = run(board(), cal, { type: "createRow", id: "n", kind: "task", parentId: null, afterId: null, title: "n", milestone: true });
    expect(taskIn(state, "n").duration).toBe(0);
    expect(applyCommand(board(), cal, { type: "createRow", id: "n", kind: "section", parentId: null, afterId: null, title: "n", milestone: true })).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("older rows without the field read as no target", () => {
    const { targetId: _gone, ...old } = task("t", dated);
    const state = project(old as TaskRow, task("m", { userStart: "2026-10-16", duration: 0 }));
    expect(applyCommand(state, cal, { type: "updateTitle", id: "t", title: "x" })).toMatchObject({ ok: true });
  });
});
