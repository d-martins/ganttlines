import { describe, expect, it } from "vitest";
import { applyChanges } from "../src/changes";
import { applyCommand } from "../src/commands";
import type { ProjectState, TaskRow } from "../src/model";
import { computeSchedule } from "../src/schedule";
import { buildTree, childrenOf } from "../src/tree";
import { calendar, datesOf, project, section, task } from "./fixtures";
import { run } from "./helpers";

// October 2026: Mon 5 … Fri 9, Mon 12 … Fri 16
const cal = calendar();
const taskIn = (state: ProjectState, id: string) => state.rows[id] as TaskRow;
const orderOf = (state: ProjectState, parentId: string | null) =>
  childrenOf(buildTree(state), parentId).map((row) => row.id);
const datesIn = (state: ProjectState, id: string) => datesOf(computeSchedule(state, cal), id);

describe("createRow", () => {
  it("creates an unscheduled task after a sibling", () => {
    const state = run(project(task("a"), task("c")), cal, {
      type: "createRow", id: "b", kind: "task", parentId: null, afterId: "a", title: "B",
    });
    expect(orderOf(state, null)).toEqual(["a", "b", "c"]);
    expect(taskIn(state, "b")).toMatchObject({ title: "B", userStart: null, duration: 1 });
  });

  it("creates a scheduled task when a start is given (click on the track)", () => {
    const state = run(project(), cal, {
      type: "createRow", id: "a", kind: "task", parentId: null, afterId: null, title: "A", start: "2026-10-10",
    });
    expect(taskIn(state, "a").userStart).toBe("2026-10-12");
  });

  it("rejects sections inside tasks and duplicate ids", () => {
    const state = project(task("t"));
    expect(applyCommand(state, cal, { type: "createRow", id: "s", kind: "section", parentId: "t", afterId: null, title: "" })).toMatchObject({ ok: false, reason: "invalid" });
    expect(applyCommand(state, cal, { type: "createRow", id: "t", kind: "task", parentId: null, afterId: null, title: "" })).toMatchObject({ ok: false, reason: "invalid" });
  });
});

describe("field edits", () => {
  it("updates title, description, color, collapse and assignee", () => {
    const state = run(
      project(task("a")),
      cal,
      { type: "updateTitle", id: "a", title: "Hooks" },
      { type: "setDescription", id: "a", description: "notes" },
      { type: "setColor", id: "a", color: "purple" },
      { type: "toggleCollapsed", id: "a", collapsed: true },
      { type: "setAssignee", id: "a", resourceId: "ana" },
    );
    expect(taskIn(state, "a")).toMatchObject({ title: "Hooks", description: "notes", color: "purple", collapsed: true, resourceId: "ana" });
  });

  it("reports missing rows", () => {
    expect(applyCommand(project(), cal, { type: "updateTitle", id: "x", title: "" })).toMatchObject({ ok: false, reason: "not_found" });
  });
});

describe("moveTask", () => {
  it("snaps a leaf to a working day", () => {
    const state = run(project(task("a", { userStart: "2026-10-05" })), cal, { type: "moveTask", id: "a", start: "2026-10-11" });
    expect(taskIn(state, "a").userStart).toBe("2026-10-12");
  });

  it("refuses to move locked tasks", () => {
    const state = project(task("a", { userStart: "2026-10-05", locked: true }));
    expect(applyCommand(state, cal, { type: "moveTask", id: "a", start: "2026-10-07" })).toMatchObject({ ok: false, reason: "locked" });
  });

  it("clamps a successor to the day after its predecessor's start", () => {
    const state = run(
      project(task("a", { userStart: "2026-10-06", duration: 3 }), task("b", { userStart: "2026-10-09", predecessorId: "a" })),
      cal,
      { type: "moveTask", id: "b", start: "2026-10-01" },
    );
    expect(taskIn(state, "b")).toMatchObject({ userStart: "2026-10-07", offset: -2 });
  });

  it("shifts a parent's subtasks by the same number of working days", () => {
    const state = run(
      project(
        task("p"),
        task("c1", { parentId: "p", userStart: "2026-10-05", duration: 2 }),
        task("c2", { parentId: "p", userStart: "2026-10-08", duration: 1, resourceId: "ana" }),
      ),
      calendar({ timeOff: [{ id: "t", resourceId: "ana", startDate: "2026-10-12", endDate: "2026-10-12" }] }),
      { type: "moveTask", id: "p", start: "2026-10-07" },
    );
    expect(taskIn(state, "c1").userStart).toBe("2026-10-07"); // +2 working days
    expect(taskIn(state, "c2").userStart).toBe("2026-10-13"); // Thu 8 +2 on Ana's calendar skips Mon 12
  });

  it("keeps overlaps between subtasks that move together", () => {
    const state = run(
      project(
        task("p"),
        task("c1", { parentId: "p", userStart: "2026-10-05", duration: 3 }),
        task("c2", { parentId: "p", userStart: "2026-10-07", predecessorId: "c1", offset: -1 }),
      ),
      cal,
      { type: "moveTask", id: "p", start: "2026-10-07" },
    );
    expect(datesIn(state, "c1")?.start).toBe("2026-10-07");
    expect(datesIn(state, "c2")?.start).toBe("2026-10-09");
    expect(taskIn(state, "c2").offset).toBe(-1);
  });

  it("rejects moving a parent without scheduled subtasks", () => {
    const state = project(task("p"), task("c", { parentId: "p" }));
    expect(applyCommand(state, cal, { type: "moveTask", id: "p", start: "2026-10-05" })).toMatchObject({ ok: false, reason: "unscheduled" });
  });
});

describe("resizeTask, setDuration, convertMilestone", () => {
  const base = project(task("a", { userStart: "2026-10-06", duration: 2 })); // Tue 6 – Wed 7

  it("resizes the end in working days, snapping back from weekends", () => {
    const state = run(base, cal, { type: "resizeTask", id: "a", edge: "end", date: "2026-10-11" });
    expect(taskIn(state, "a").duration).toBe(4); // Tue 6 – Fri 9
  });

  it("resizes the start while keeping the end", () => {
    const state = run(base, cal, { type: "resizeTask", id: "a", edge: "start", date: "2026-10-05" });
    expect(taskIn(state, "a")).toMatchObject({ userStart: "2026-10-05", duration: 3 });
    expect(datesIn(state, "a")?.end).toBe("2026-10-07");
  });

  it("never shrinks below one day", () => {
    const state = run(base, cal, { type: "resizeTask", id: "a", edge: "end", date: "2026-10-01" });
    expect(taskIn(state, "a").duration).toBe(1);
  });

  it("sets durations and converts milestones", () => {
    let state = run(base, cal, { type: "setDuration", id: "a", duration: 5 });
    expect(taskIn(state, "a").duration).toBe(5);
    state = run(state, cal, { type: "convertMilestone", id: "a", milestone: true });
    expect(taskIn(state, "a").duration).toBe(0);
    expect(applyCommand(state, cal, { type: "resizeTask", id: "a", edge: "end", date: "2026-10-09" })).toMatchObject({ ok: false, reason: "invalid" });
    expect(applyCommand(state, cal, { type: "setDuration", id: "a", duration: 0 })).toMatchObject({ ok: false, reason: "invalid" });
  });
});

describe("setLocked", () => {
  it("pins the currently displayed start when locking", () => {
    const state = run(
      project(task("a", { userStart: "2026-10-05", duration: 3 }), task("b", { userStart: "2026-10-05", predecessorId: "a" })),
      cal,
      { type: "setLocked", id: "b", locked: true },
    );
    expect(taskIn(state, "b")).toMatchObject({ locked: true, userStart: "2026-10-08" });
  });
});

describe("linkTasks", () => {
  const base = project(task("a", { userStart: "2026-10-05", duration: 3 }), task("b", { userStart: "2026-10-06" }));

  it("makes the earlier-starting task the predecessor, whichever was dragged", () => {
    for (const [fromId, toId] of [["a", "b"], ["b", "a"]] as const) {
      const state = run(base, cal, { type: "linkTasks", fromId, toId });
      expect(taskIn(state, "b")).toMatchObject({ predecessorId: "a", offset: 0 });
      expect(datesIn(state, "b")?.start).toBe("2026-10-08");
    }
  });

  it("uses the dragged-from task as predecessor when both start the same day", () => {
    const sameDay = project(task("a", { userStart: "2026-10-05" }), task("b", { userStart: "2026-10-05" }));
    const state = run(sameDay, cal, { type: "linkTasks", fromId: "b", toId: "a" });
    expect(taskIn(state, "a").predecessorId).toBe("b");
  });

  it("replaces an existing predecessor", () => {
    const state = run(
      project(task("x", { userStart: "2026-10-01" }), task("a", { userStart: "2026-10-02" }), task("b", { userStart: "2026-10-06", predecessorId: "x" })),
      cal,
      { type: "linkTasks", fromId: "a", toId: "b" },
    );
    expect(taskIn(state, "b").predecessorId).toBe("a");
  });

  it("rejects cycles, self links and unscheduled tasks", () => {
    const chain = project(task("a", { userStart: "2026-10-05" }), task("b", { userStart: "2026-10-06", predecessorId: "a" }));
    const parentChild = project(task("p"), task("c", { parentId: "p", userStart: "2026-10-06" }), task("d", { userStart: "2026-10-05" }));
    expect(applyCommand(chain, cal, { type: "linkTasks", fromId: "a", toId: "a" })).toMatchObject({ ok: false, reason: "invalid" });
    expect(applyCommand(project(task("a"), task("b", { userStart: "2026-10-06" })), cal, { type: "linkTasks", fromId: "a", toId: "b" })).toMatchObject({ ok: false, reason: "unscheduled" });
    const withD = run(parentChild, cal, { type: "linkTasks", fromId: "d", toId: "p" });
    expect(applyCommand(withD, cal, { type: "linkTasks", fromId: "c", toId: "p" })).toMatchObject({ ok: false, reason: "cycle" });
  });
});

describe("removePredecessor and setOffset", () => {
  const linked = project(
    task("a", { userStart: "2026-10-05", duration: 3 }), // Mon 5 – Wed 7
    task("b", { userStart: "2026-10-05", predecessorId: "a" }), // shown Thu 8
  );

  it("keeps the task in place when its predecessor is removed", () => {
    const state = run(linked, cal, { type: "removePredecessor", id: "b" });
    expect(taskIn(state, "b")).toMatchObject({ predecessorId: null, offset: 0, userStart: "2026-10-08" });
  });

  it("places the task exactly at the new offset", () => {
    const state = run(linked, cal, { type: "setOffset", id: "b", offset: 2 });
    expect(taskIn(state, "b")).toMatchObject({ offset: 2, userStart: "2026-10-12" });
    const overlapped = run(linked, cal, { type: "setOffset", id: "b", offset: -1 });
    expect(datesIn(overlapped, "b")?.start).toBe("2026-10-07");
  });

  it("clamps the offset so the task starts after its predecessor's start", () => {
    const state = run(linked, cal, { type: "setOffset", id: "b", offset: -10 });
    expect(taskIn(state, "b")).toMatchObject({ offset: -2, userStart: "2026-10-06" });
  });
});

describe("tree commands", () => {
  const base = project(section("s"), task("a", { parentId: "s" }), task("b", { parentId: "s" }), task("c", { parentId: "s" }));

  it("indents under the previous sibling and outdents after the parent", () => {
    let state = run(base, cal, { type: "indent", id: "b" });
    expect(taskIn(state, "b").parentId).toBe("a");
    expect(orderOf(state, "s")).toEqual(["a", "c"]);
    state = run(state, cal, { type: "outdent", id: "b" });
    expect(orderOf(state, "s")).toEqual(["a", "b", "c"]);
  });

  it("rejects indenting the first row and outdenting a top-level row", () => {
    expect(applyCommand(base, cal, { type: "indent", id: "a" })).toMatchObject({ ok: false, reason: "invalid" });
    expect(applyCommand(base, cal, { type: "outdent", id: "s" })).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("reorders and reparents rows, but not into themselves", () => {
    const state = run(base, cal, { type: "moveRow", id: "a", parentId: "s", afterId: "c" });
    expect(orderOf(state, "s")).toEqual(["b", "c", "a"]);
    expect(applyCommand(base, cal, { type: "moveRow", id: "s", parentId: "a", afterId: null })).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("deletes subtrees and detaches their successors in place", () => {
    const state = run(
      project(task("p"), task("c", { parentId: "p", userStart: "2026-10-05", duration: 3 }), task("d", { userStart: "2026-10-05", predecessorId: "c" })),
      cal,
      { type: "deleteRows", ids: ["p"] },
    );
    expect(Object.keys(state.rows)).toEqual(["d"]);
    expect(taskIn(state, "d")).toMatchObject({ predecessorId: null, userStart: "2026-10-08" });
  });

  it("duplicates a task right after the original", () => {
    const state = run(base, cal, { type: "duplicateTask", id: "a", newId: "a2" });
    expect(orderOf(state, "s")).toEqual(["a", "a2", "b", "c"]);
  });
});

describe("changes", () => {
  it("reports field changes that replay forward and backward", () => {
    const before = project(task("a", { userStart: "2026-10-05" }));
    const result = applyCommand(before, cal, { type: "moveTask", id: "a", start: "2026-10-07" });
    if (!result.ok) throw new Error(result.message);
    expect(result.changes).toEqual([{ rowId: "a", field: "userStart", before: "2026-10-05", after: "2026-10-07" }]);
    expect(applyChanges(before, result.changes)).toEqual(result.state);
    expect(applyChanges(result.state, result.changes, "backward")).toEqual(before);
  });

  it("reports created and deleted rows as whole-row changes", () => {
    const result = applyCommand(project(), cal, { type: "createRow", id: "a", kind: "section", parentId: null, afterId: null, title: "S" });
    if (!result.ok) throw new Error(result.message);
    expect(result.changes).toEqual([{ rowId: "a", field: "*", before: null, after: result.state.rows.a }]);
  });
});
