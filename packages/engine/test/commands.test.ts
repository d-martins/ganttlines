import { describe, expect, it } from "vitest";
import { applyChanges } from "../src/changes";
import { applyCommand, MAX_DATE, MAX_DURATION, MAX_OFFSET, MIN_DATE } from "../src/commands";
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

  it("rejects an empty id", () => {
    expect(applyCommand(project(), cal, { type: "createRow", id: "", kind: "task", parentId: null, afterId: null, title: "" })).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("rejects instead of throwing when siblings share a position", () => {
    const state = project(task("a", { position: "a0" }), task("b", { position: "a0" }));
    expect(applyCommand(state, cal, { type: "createRow", id: "n", kind: "task", parentId: null, afterId: "a", title: "" })).toMatchObject({ ok: false, reason: "invalid" });
  });
});

describe("calendars without working days", () => {
  it("keeps scheduling and accepting commands when an assignee is off for years", () => {
    const longLeave = calendar({ timeOff: [{ id: "t", resourceId: "ana", startDate: "2026-01-01", endDate: "2040-01-01" }] });
    const state = project(task("a", { userStart: "2026-10-05", duration: 2, resourceId: "ana" }), task("b", { userStart: "2026-10-05" }));
    expect(datesOf(computeSchedule(state, longLeave), "a")).toEqual({ start: "2026-10-05", end: "2026-10-06" });
    expect(applyCommand(state, longLeave, { type: "updateTitle", id: "b", title: "B" })).toMatchObject({ ok: true });
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

describe("input bounds", () => {
  const base = project(task("a", { userStart: "2026-10-05" }), task("b", { userStart: "2026-10-06", predecessorId: "a" }));

  it("exposes the limits", () => {
    expect({ MAX_DURATION, MAX_OFFSET, MIN_DATE, MAX_DATE }).toEqual({ MAX_DURATION: 3660, MAX_OFFSET: 3660, MIN_DATE: "1970-01-01", MAX_DATE: "2199-12-31" });
  });

  it("rejects huge offsets quickly", () => {
    const started = Date.now();
    expect(applyCommand(base, cal, { type: "setOffset", id: "b", offset: 1e300 })).toMatchObject({ ok: false, reason: "invalid" });
    expect(applyCommand(base, cal, { type: "setOffset", id: "b", offset: -(MAX_OFFSET + 1) })).toMatchObject({ ok: false, reason: "invalid" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(applyCommand(base, cal, { type: "setOffset", id: "b", offset: MAX_OFFSET })).toMatchObject({ ok: true });
  });

  it("rejects durations above the limit, directly or by resizing", () => {
    expect(applyCommand(base, cal, { type: "setDuration", id: "a", duration: 5000 })).toMatchObject({ ok: false, reason: "invalid" });
    expect(applyCommand(base, cal, { type: "setDuration", id: "a", duration: MAX_DURATION })).toMatchObject({ ok: true });
    expect(applyCommand(base, cal, { type: "resizeTask", id: "a", edge: "end", date: "2199-12-31" })).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("rejects dates outside the supported range", () => {
    expect(applyCommand(base, cal, { type: "moveTask", id: "a", start: "9999-12-31" })).toMatchObject({ ok: false, reason: "invalid" });
    expect(applyCommand(base, cal, { type: "moveTask", id: "a", start: "1969-12-31" })).toMatchObject({ ok: false, reason: "invalid" });
    expect(applyCommand(base, cal, { type: "resizeTask", id: "a", edge: "start", date: "1900-01-01" })).toMatchObject({ ok: false, reason: "invalid" });
    expect(applyCommand(base, cal, { type: "createRow", id: "n", kind: "task", parentId: null, afterId: null, title: "", start: "2200-01-01" })).toMatchObject({ ok: false, reason: "invalid" });
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

  it("moves successors of nested sub-parents with the group", () => {
    const state = run(
      project(
        task("p"),
        task("q", { parentId: "p" }),
        task("q1", { parentId: "q", userStart: "2026-10-12", duration: 2 }), // Mon 12 – Tue 13
        task("r", { parentId: "p", userStart: "2026-10-14", predecessorId: "q" }),
      ),
      cal,
      { type: "moveTask", id: "p", start: "2026-10-05" },
    );
    expect(datesIn(state, "q1")?.start).toBe("2026-10-05");
    expect(datesIn(state, "r")?.start).toBe("2026-10-07");
    expect(taskIn(state, "r")).toMatchObject({ userStart: "2026-10-07", offset: 0 });
  });

  it("places successors of a locked inside predecessor like a normal leaf move", () => {
    const state = run(
      project(
        task("p"),
        task("q", { parentId: "p" }),
        task("q1", { parentId: "q", userStart: "2026-10-12", duration: 2, locked: true }), // Mon 12 – Tue 13
        task("r", { parentId: "p", userStart: "2026-10-14", predecessorId: "q" }),
      ),
      cal,
      { type: "moveTask", id: "p", start: "2026-10-05" },
    );
    expect(datesIn(state, "q1")?.start).toBe("2026-10-12");
    expect(taskIn(state, "r")).toMatchObject({ userStart: "2026-10-13", offset: -1 });
    expect(datesIn(state, "r")?.start).toBe(taskIn(state, "r").userStart);
  });

  describe("with an outside task between subtasks", () => {
    // p contains l2 and l1; outside, x depends on l2 and l1 depends on x (overlapping it by one day).
    const chained = (l2Start: string) =>
      project(
        task("p"),
        task("l2", { parentId: "p", userStart: l2Start }),
        task("l1", { parentId: "p", userStart: "2026-10-05", predecessorId: "x", offset: -1 }),
        task("x", { userStart: "2026-10-05", duration: 2, predecessorId: "l2" }), // pushed by l2
      );

    it("moves the whole group rigidly when dragged later", () => {
      const before = chained("2026-10-05"); // l2 Mon 5, x Tue 6 – Wed 7, l1 Wed 7
      expect(datesIn(before, "l1")?.start).toBe("2026-10-07");
      const state = run(before, cal, { type: "moveTask", id: "p", start: "2026-10-06" });
      expect(datesIn(state, "l2")?.start).toBe("2026-10-06");
      expect(datesIn(state, "x")?.start).toBe("2026-10-07");
      expect(datesIn(state, "l1")?.start).toBe("2026-10-08");
      expect(taskIn(state, "l1")).toMatchObject({ userStart: "2026-10-08", offset: -1 });
    });

    it("moves the whole group rigidly when dragged earlier", () => {
      const before = chained("2026-10-06"); // l2 Tue 6, x Wed 7 – Thu 8, l1 Thu 8
      expect(datesIn(before, "l1")?.start).toBe("2026-10-08");
      const state = run(before, cal, { type: "moveTask", id: "p", start: "2026-10-05" });
      expect(datesIn(state, "l2")?.start).toBe("2026-10-05");
      expect(datesIn(state, "x")?.start).toBe("2026-10-06");
      expect(datesIn(state, "l1")?.start).toBe("2026-10-07");
      expect(taskIn(state, "l1")).toMatchObject({ userStart: "2026-10-07", offset: -1 });
    });
  });

  describe("under a parent with a predecessor", () => {
    const nested = project(
      task("a", { userStart: "2026-10-05", duration: 3 }), // Mon 5 – Wed 7
      task("p", { predecessorId: "a" }),
      task("c", { parentId: "p", userStart: "2026-10-08", duration: 2 }), // Thu 8 – Fri 9
    );

    it("records dragging the parent as an overlap with its predecessor", () => {
      const state = run(nested, cal, { type: "moveTask", id: "p", start: "2026-10-06" });
      expect(taskIn(state, "p").offset).toBe(-2);
      expect(datesIn(state, "c")?.start).toBe("2026-10-06");
      expect(taskIn(state, "c").userStart).toBe("2026-10-06");
    });

    it("changes nothing when dragged to its current start past a violating locked subtask", () => {
      const state = project(
        task("a", { userStart: "2026-10-05", duration: 3 }), // Mon 5 – Wed 7
        task("p", { predecessorId: "a" }),
        task("l", { parentId: "p", userStart: "2026-10-05", locked: true }), // violates p's constraint
        task("c", { parentId: "p", userStart: "2026-10-08" }),
      );
      expect(datesIn(state, "p")?.start).toBe("2026-10-05");
      const result = applyCommand(state, cal, { type: "moveTask", id: "p", start: "2026-10-05" });
      expect(result).toMatchObject({ ok: true, changes: [] });
    });

    it("rejects dragging a parent whose scheduled subtasks are all locked", () => {
      const state = project(
        task("a", { userStart: "2026-10-05", duration: 3 }),
        task("p", { predecessorId: "a" }),
        task("l", { parentId: "p", userStart: "2026-10-08", locked: true }),
        task("u", { parentId: "p" }), // unscheduled
      );
      expect(applyCommand(state, cal, { type: "moveTask", id: "p", start: "2026-10-06" })).toMatchObject({ ok: false, reason: "locked" });
    });

    it("clamps a subtask drag to the inherited constraint", () => {
      const state = run(nested, cal, { type: "moveTask", id: "c", start: "2026-10-06" });
      expect(datesIn(state, "c")?.start).toBe("2026-10-08");
      expect(taskIn(state, "c").userStart).toBe("2026-10-08");
      expect(taskIn(state, "p").offset).toBe(0);
    });
  });

  it("rejects instead of throwing when the stored state has a cycle", () => {
    const cyclic = project(task("a", { userStart: "2026-10-05", predecessorId: "b" }), task("b", { userStart: "2026-10-06", predecessorId: "a" }));
    expect(applyCommand(cyclic, cal, { type: "moveTask", id: "a", start: "2026-10-07" })).toMatchObject({ ok: false, reason: "cycle" });
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

  it("keeps the duration when converting a non-milestone to a task", () => {
    const state = run(base, cal, { type: "setDuration", id: "a", duration: 5 }, { type: "convertMilestone", id: "a", milestone: false });
    expect(taskIn(state, "a").duration).toBe(5);
    const milestone = run(state, cal, { type: "convertMilestone", id: "a", milestone: true }, { type: "convertMilestone", id: "a", milestone: false });
    expect(taskIn(milestone, "a").duration).toBe(1);
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

  it("unlocks a task that has become a parent", () => {
    let state = run(
      project(task("a", { userStart: "2026-10-05" }), task("b", { userStart: "2026-10-06" })),
      cal,
      { type: "setLocked", id: "a", locked: true },
      { type: "indent", id: "b" },
    );
    expect(applyCommand(state, cal, { type: "setLocked", id: "a", locked: true })).toMatchObject({ ok: false, reason: "invalid" });
    state = run(state, cal, { type: "setLocked", id: "a", locked: false });
    expect(taskIn(state, "a").locked).toBe(false);
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

  it("sets the offset of a locked parent task", () => {
    const state = run(
      project(task("a", { userStart: "2026-10-05", duration: 3 }), task("p", { predecessorId: "a", locked: true }), task("c", { parentId: "p", userStart: "2026-10-05" })),
      cal,
      { type: "setOffset", id: "p", offset: 1 },
    );
    expect(taskIn(state, "p").offset).toBe(1);
  });

  describe("on a parent task", () => {
    const parentLinked = project(
      task("a", { userStart: "2026-10-05", duration: 3 }), // Mon 5 – Wed 7
      task("p", { predecessorId: "a" }),
      task("c", { parentId: "p", userStart: "2026-10-05" }), // shown Thu 8
    );

    it("keeps the subtasks in place when the predecessor is removed", () => {
      const state = run(parentLinked, cal, { type: "removePredecessor", id: "p" });
      expect(taskIn(state, "p")).toMatchObject({ predecessorId: null, offset: 0 });
      expect(datesIn(state, "c")?.start).toBe("2026-10-08");
    });

    it("only pins subtasks that the parent's constraint was pushing", () => {
      const state = run(
        project(
          task("a", { userStart: "2026-10-05", duration: 3 }), // Mon 5 – Wed 7
          task("p", { predecessorId: "a" }),
          task("c1", { parentId: "p", userStart: "2026-10-05" }), // shown Thu 8
          task("c2", { parentId: "p", userStart: "2026-10-05", predecessorId: "c1" }), // shown Fri 9, follows c1
        ),
        cal,
        { type: "removePredecessor", id: "p" },
      );
      expect(taskIn(state, "c1").userStart).toBe("2026-10-08");
      expect(taskIn(state, "c2").userStart).toBe("2026-10-05");
      expect(datesIn(state, "c2")?.start).toBe("2026-10-09");
      const movedBack = run(state, cal, { type: "moveTask", id: "c1", start: "2026-10-05" });
      expect(datesIn(movedBack, "c2")?.start).toBe("2026-10-06");
    });

    it("keeps the subtasks in place when the predecessor is deleted", () => {
      const state = run(parentLinked, cal, { type: "deleteRows", ids: ["a"] });
      expect(taskIn(state, "p").predecessorId).toBeNull();
      expect(datesIn(state, "c")?.start).toBe("2026-10-08");
    });
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

  it("ignores ids that no longer exist when deleting", () => {
    const state = run(base, cal, { type: "deleteRows", ids: ["gone", "b"] });
    expect(orderOf(state, "s")).toEqual(["a", "c"]);
  });

  it("keeps a task where it was shown when its last subtask is deleted", () => {
    const state = run(
      project(task("p", { userStart: "2026-09-01" }), task("c", { parentId: "p", userStart: "2026-10-05", duration: 3 })),
      cal,
      { type: "deleteRows", ids: ["c"] },
    );
    expect(taskIn(state, "p")).toMatchObject({ userStart: "2026-10-05", duration: 3 });
    expect(datesIn(state, "p")).toEqual({ start: "2026-10-05", end: "2026-10-07" });
  });

  it("keeps a task where it was shown when its last subtask is outdented", () => {
    const state = run(
      project(task("p"), task("c", { parentId: "p", userStart: "2026-10-08", duration: 3 })), // Thu 8 – Mon 12
      cal,
      { type: "outdent", id: "c" },
    );
    expect(taskIn(state, "p")).toMatchObject({ userStart: "2026-10-08", duration: 3 });
    expect(datesIn(state, "p")).toEqual({ start: "2026-10-08", end: "2026-10-12" });
  });

  it("refuses to duplicate a parent task", () => {
    const state = project(task("p"), task("c", { parentId: "p" }));
    expect(applyCommand(state, cal, { type: "duplicateTask", id: "p", newId: "p2" })).toMatchObject({
      ok: false, reason: "invalid", message: "Only single tasks can be duplicated",
    });
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
