import { describe, expect, it } from "vitest";
import { applyChanges } from "../src/changes";
import { applyCommand, MAX_DATE, MAX_DURATION, MIN_DATE } from "../src/commands";
import { MAX_LAG, MAX_LINKS_PER_TASK, type LinkKind } from "../src/links";
import type { ProjectState, TaskRow } from "../src/model";
import { computeSchedule } from "../src/schedule";
import { buildTree, childrenOf } from "../src/tree";
import { revertChanges } from "../src/undo";
import { calendar, datesOf, fsLinkInto, halvesOf, link, project, section, task } from "./fixtures";
import { run } from "./helpers";

// October 2026: Mon 5 … Fri 9, Mon 12 … Fri 16
const cal = calendar();
const taskIn = (state: ProjectState, id: string) => state.rows[id] as TaskRow;
const lagOf = (state: ProjectState, id: string) => fsLinkInto(state, id)?.lag;
const predecessorOf = (state: ProjectState, id: string) => fsLinkInto(state, id)?.predecessorId ?? null;
const orderOf = (state: ProjectState, parentId: string | null) =>
  childrenOf(buildTree(state), parentId).map((row) => row.id);
const datesIn = (state: ProjectState, id: string) => datesOf(computeSchedule(state, cal), id);
const halvesIn = (state: ProjectState, id: string) => halvesOf(computeSchedule(state, cal), id);

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

describe("calendars with long time off", () => {
  it("keeps scheduling and accepting commands when an assignee is off for years", () => {
    const longLeave = calendar({ timeOff: [{ id: "t", resourceId: "ana", startDate: "2026-01-01", endDate: "2040-01-01" }] });
    const state = project(task("a", { userStart: "2026-10-05", duration: 2, resourceId: "ana" }), task("b", { userStart: "2026-10-05" }));
    expect(datesOf(computeSchedule(state, longLeave), "a")).toEqual({ start: "2026-10-05", end: "2026-10-06" });
    expect(applyCommand(state, longLeave, { type: "updateTitle", id: "b", title: "B" })).toMatchObject({ ok: true });
  });
});

describe("assignees with a stretch of time off longer than the scan limit", () => {
  const leftCal = calendar({ timeOff: [{ id: "t", resourceId: "ana", startDate: "2020-01-01", endDate: "2045-12-31" }] });
  const linked = project(
    task("a", { userStart: "2026-10-05", duration: 3, resourceId: "ana" }), // Mon 5 – Wed 7
    task("b", { userStart: "2026-10-05", resourceId: "ana" }), // Thu 8
    link("a", "b"),
  );

  it("schedules long tasks quickly", () => {
    const state = project(task("a", { userStart: "2026-10-05", duration: 3660, resourceId: "ana" }));
    const started = Date.now();
    const schedule = computeSchedule(state, leftCal);
    const elapsed = Date.now() - started;
    expect(schedule.get("a")?.span).not.toBeNull();
    expect(elapsed).toBeLessThan(200);
  });

  it("records an overlap drag as a negative offset", () => {
    const state = run(linked, leftCal, { type: "moveTask", id: "b", start: "2026-10-06" });
    expect(taskIn(state, "b")).toMatchObject({ userStart: "2026-10-06" });
    expect(lagOf(state, "b")).toBe(-2);
    expect(datesOf(computeSchedule(state, leftCal), "b")?.start).toBe("2026-10-06");
  });

  it("resizes to the expected duration", () => {
    const state = run(linked, leftCal, { type: "resizeTask", id: "a", edge: "end", date: "2026-10-11" });
    expect(taskIn(state, "a").duration).toBe(5); // Mon 5 – Fri 9
  });
});

describe("field edits", () => {
  it("updates title, description, color and assignee", () => {
    const state = run(
      project(task("a")),
      cal,
      { type: "updateTitle", id: "a", title: "Hooks" },
      { type: "setDescription", id: "a", description: "notes" },
      { type: "setColor", id: "a", color: "purple" },
      { type: "setAssignee", id: "a", resourceId: "ana" },
    );
    expect(taskIn(state, "a")).toMatchObject({ title: "Hooks", description: "notes", color: "purple", resourceId: "ana" });
  });

  it("reports missing rows", () => {
    expect(applyCommand(project(), cal, { type: "updateTitle", id: "x", title: "" })).toMatchObject({ ok: false, reason: "not_found" });
  });
});

describe("input bounds", () => {
  const base = project(task("a", { userStart: "2026-10-05" }), task("b", { userStart: "2026-10-06" }), link("a", "b"));

  it("exposes the limits", () => {
    expect({ MAX_DURATION, MAX_LAG, MIN_DATE, MAX_DATE }).toEqual({ MAX_DURATION: 3660, MAX_LAG: 3660, MIN_DATE: "1970-01-01", MAX_DATE: "2199-12-31" });
  });

  it("rejects huge offsets quickly", () => {
    const started = Date.now();
    const update = (lag: number) => applyCommand(base, cal, { type: "updateLink", predecessorId: "a", followerId: "b", kind: "FS", lag });
    expect(update(1e300)).toMatchObject({ ok: false, reason: "invalid" });
    expect(update(-(MAX_LAG + 1))).toMatchObject({ ok: false, reason: "invalid" });
    expect(applyCommand(base, cal, { type: "addLink", predecessorId: "b", followerId: "a", kind: "SS", lag: 1e300 })).toMatchObject({ ok: false, reason: "invalid" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(update(MAX_LAG)).toMatchObject({ ok: true });
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
      project(task("a", { userStart: "2026-10-06", duration: 3 }), task("b", { userStart: "2026-10-09" }), link("a", "b")),
      cal,
      { type: "moveTask", id: "b", start: "2026-10-01" },
    );
    expect(taskIn(state, "b")).toMatchObject({ userStart: "2026-10-07" });
    expect(lagOf(state, "b")).toBe(-2);
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
        task("c2", { parentId: "p", userStart: "2026-10-07" }),
        link("c1", "c2", -1),
      ),
      cal,
      { type: "moveTask", id: "p", start: "2026-10-07" },
    );
    expect(datesIn(state, "c1")?.start).toBe("2026-10-07");
    expect(datesIn(state, "c2")?.start).toBe("2026-10-09");
    expect(lagOf(state, "c2")).toBe(-1);
  });

  it("moves successors of nested sub-parents with the group", () => {
    const state = run(
      project(
        task("p"),
        task("q", { parentId: "p" }),
        task("q1", { parentId: "q", userStart: "2026-10-12", duration: 2 }), // Mon 12 – Tue 13
        task("r", { parentId: "p", userStart: "2026-10-14" }),
        link("q", "r"),
      ),
      cal,
      { type: "moveTask", id: "p", start: "2026-10-05" },
    );
    expect(datesIn(state, "q1")?.start).toBe("2026-10-05");
    expect(datesIn(state, "r")?.start).toBe("2026-10-07");
    expect(taskIn(state, "r")).toMatchObject({ userStart: "2026-10-07" });
    expect(lagOf(state, "r")).toBe(0);
  });

  it("places successors of a locked inside predecessor like a normal leaf move", () => {
    const state = run(
      project(
        task("p"),
        task("q", { parentId: "p" }),
        task("q1", { parentId: "q", userStart: "2026-10-12", duration: 2, locked: true }), // Mon 12 – Tue 13
        task("r", { parentId: "p", userStart: "2026-10-14" }),
        link("q", "r"),
      ),
      cal,
      { type: "moveTask", id: "p", start: "2026-10-05" },
    );
    expect(datesIn(state, "q1")?.start).toBe("2026-10-12");
    expect(taskIn(state, "r")).toMatchObject({ userStart: "2026-10-13" });
    expect(lagOf(state, "r")).toBe(-1);
    expect(datesIn(state, "r")?.start).toBe(taskIn(state, "r").userStart);
  });

  describe("with an outside task between subtasks", () => {
    // p contains l2 and l1; outside, x depends on l2 and l1 depends on x (overlapping it by one day).
    const chained = (l2Start: string) =>
      project(
        task("p"),
        task("l2", { parentId: "p", userStart: l2Start }),
        task("l1", { parentId: "p", userStart: "2026-10-05" }),
        link("x", "l1", -1),
        task("x", { userStart: "2026-10-05", duration: 2 }), // pushed by l2
        link("l2", "x"),
      );

    it("moves the whole group rigidly when dragged later", () => {
      const before = chained("2026-10-05"); // l2 Mon 5, x Tue 6 – Wed 7, l1 Wed 7
      expect(datesIn(before, "l1")?.start).toBe("2026-10-07");
      const state = run(before, cal, { type: "moveTask", id: "p", start: "2026-10-06" });
      expect(datesIn(state, "l2")?.start).toBe("2026-10-06");
      expect(datesIn(state, "x")?.start).toBe("2026-10-07");
      expect(datesIn(state, "l1")?.start).toBe("2026-10-08");
      expect(taskIn(state, "l1")).toMatchObject({ userStart: "2026-10-08" });
      expect(lagOf(state, "l1")).toBe(-1);
    });

    it("moves the whole group rigidly when dragged earlier", () => {
      const before = chained("2026-10-06"); // l2 Tue 6, x Wed 7 – Thu 8, l1 Thu 8
      expect(datesIn(before, "l1")?.start).toBe("2026-10-08");
      const state = run(before, cal, { type: "moveTask", id: "p", start: "2026-10-05" });
      expect(datesIn(state, "l2")?.start).toBe("2026-10-05");
      expect(datesIn(state, "x")?.start).toBe("2026-10-06");
      expect(datesIn(state, "l1")?.start).toBe("2026-10-07");
      expect(taskIn(state, "l1")).toMatchObject({ userStart: "2026-10-07" });
      expect(lagOf(state, "l1")).toBe(-1);
    });
  });

  describe("under a parent with a predecessor", () => {
    const nested = project(
      task("a", { userStart: "2026-10-05", duration: 3 }), // Mon 5 – Wed 7
      task("p"),
      link("a", "p"),
      task("c", { parentId: "p", userStart: "2026-10-08", duration: 2 }), // Thu 8 – Fri 9
    );

    it("records dragging the parent as an overlap with its predecessor", () => {
      const state = run(nested, cal, { type: "moveTask", id: "p", start: "2026-10-06" });
      expect(lagOf(state, "p")).toBe(-2);
      expect(datesIn(state, "c")?.start).toBe("2026-10-06");
      expect(taskIn(state, "c").userStart).toBe("2026-10-06");
    });

    it("changes nothing when dragged to its current start past a violating locked subtask", () => {
      const state = project(
        task("a", { userStart: "2026-10-05", duration: 3 }), // Mon 5 – Wed 7
        task("p"),
        link("a", "p"),
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
        task("p"),
        link("a", "p"),
        task("l", { parentId: "p", userStart: "2026-10-08", locked: true }),
        task("u", { parentId: "p" }), // unscheduled
      );
      expect(applyCommand(state, cal, { type: "moveTask", id: "p", start: "2026-10-06" })).toMatchObject({ ok: false, reason: "locked" });
    });

    it("clamps a subtask drag to the inherited constraint", () => {
      const state = run(nested, cal, { type: "moveTask", id: "c", start: "2026-10-06" });
      expect(datesIn(state, "c")?.start).toBe("2026-10-08");
      expect(taskIn(state, "c").userStart).toBe("2026-10-08");
      expect(lagOf(state, "p")).toBe(0);
    });
  });

  it("rejects instead of throwing when the stored state has a cycle", () => {
    const cyclic = project(task("a", { userStart: "2026-10-05" }), link("b", "a"), task("b", { userStart: "2026-10-06" }), link("a", "b"));
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

  it("never shrinks below half a day", () => {
    const state = run(base, cal, { type: "resizeTask", id: "a", edge: "end", date: "2026-10-01" });
    expect(taskIn(state, "a").duration).toBe(0.5);
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

describe("half days", () => {
  const base = project(task("a", { userStart: "2026-10-06", duration: 2 }), task("b", { userStart: "2026-10-06" }), link("a", "b"));

  it("takes durations in half days: a task ends at midday and its successor starts that afternoon", () => {
    const state = run(base, cal, { type: "setDuration", id: "a", duration: 2.5 });
    expect(taskIn(state, "a").duration).toBe(2.5);
    expect(halvesIn(state, "a")).toEqual({ start: "2026-10-06 am", end: "2026-10-08 am" }); // Tue – Thu midday
    expect(halvesIn(state, "b")).toEqual({ start: "2026-10-08 pm", end: "2026-10-09 am" });
    const half = run(base, cal, { type: "setDuration", id: "a", duration: 0.5 });
    expect(halvesIn(half, "a")).toEqual({ start: "2026-10-06 am", end: "2026-10-06 am" });
    expect(halvesIn(half, "b")).toEqual({ start: "2026-10-06 pm", end: "2026-10-07 am" });
  });

  it("starts tasks in the afternoon and carries half days over weekends", () => {
    let state = run(base, cal, { type: "moveTask", id: "a", start: "2026-10-09", half: "afternoon" }); // Fri pm
    expect(taskIn(state, "a")).toMatchObject({ userStart: "2026-10-09", startsAfternoon: true });
    expect(halvesIn(state, "a")).toEqual({ start: "2026-10-09 pm", end: "2026-10-13 am" }); // Fri pm, Mon, Tue am: 2 days
    expect(halvesIn(state, "b")).toEqual({ start: "2026-10-13 pm", end: "2026-10-14 am" });
    state = run(state, cal, { type: "moveTask", id: "a", start: "2026-10-10", half: "afternoon" }); // Saturday: the next working morning
    expect(halvesIn(state, "a")).toEqual({ start: "2026-10-12 am", end: "2026-10-13 pm" });
    state = run(state, cal, { type: "moveTask", id: "a", start: "2026-10-06" }); // no half: the morning
    expect(taskIn(state, "a").startsAfternoon).toBe(false);
  });

  it("resizes edges to half days", () => {
    let state = run(base, cal, { type: "resizeTask", id: "a", edge: "end", date: "2026-10-08", half: "morning" });
    expect(taskIn(state, "a").duration).toBe(2.5);
    state = run(state, cal, { type: "resizeTask", id: "a", edge: "start", date: "2026-10-06", half: "afternoon" });
    expect(taskIn(state, "a")).toMatchObject({ userStart: "2026-10-06", startsAfternoon: true, duration: 2 });
    expect(halvesIn(state, "a")?.end).toBe("2026-10-08 am");
  });

  it("overlaps a successor by half days, but never before the day after its predecessor starts", () => {
    // b is dropped on Wed morning, half a day into a (Tue – Thu midday): a -1.5 day overlap
    let state = run(base, cal, { type: "setDuration", id: "a", duration: 2.5 }, { type: "moveTask", id: "b", start: "2026-10-07" });
    expect(taskIn(state, "b")).toMatchObject({ userStart: "2026-10-07", startsAfternoon: false });
    expect(lagOf(state, "b")).toBe(-1.5);
    state = run(state, cal, { type: "moveTask", id: "b", start: "2026-10-06", half: "afternoon" });
    expect(halvesIn(state, "b")?.start).toBe("2026-10-07 am");
  });

  it("puts milestones on the morning and starts their successors the next working day", () => {
    const state = run(project(task("m", { userStart: "2026-10-06", startsAfternoon: true, duration: 1 }), task("n", { userStart: "2026-10-06" }), link("m", "n")), cal, {
      type: "convertMilestone",
      id: "m",
      milestone: true,
    });
    expect(taskIn(state, "m").startsAfternoon).toBe(false);
    expect(halvesIn(state, "n")?.start).toBe("2026-10-07 am");
  });

  it("refuses other fractions and anything under half a day", () => {
    for (const duration of [0.25, 1.3, -0.5]) {
      expect(applyCommand(base, cal, { type: "setDuration", id: "a", duration })).toMatchObject({ ok: false, reason: "invalid" });
    }
  });
});

describe("setActualDuration", () => {
  const base = project(
    task("a", { userStart: "2026-10-06", duration: 3 }),
    task("b", { userStart: "2026-10-06" }),
    link("a", "b"),
    task("p"),
    task("c", { parentId: "p", userStart: "2026-10-05" }),
  );

  it("records the working days a task really took, without moving anything", () => {
    const before = computeSchedule(base, cal);
    const state = run(base, cal, { type: "setActualDuration", id: "a", days: 5 });
    expect(taskIn(state, "a").actualDuration).toBe(5);
    expect(computeSchedule(state, cal)).toEqual(before);
    expect(taskIn(run(state, cal, { type: "setActualDuration", id: "a", days: 2.5 }), "a").actualDuration).toBe(2.5);
    expect(taskIn(run(state, cal, { type: "setActualDuration", id: "a", days: null }), "a").actualDuration).toBeNull();
  });

  it("works on locked tasks, but not on milestones, parents or odd values", () => {
    const locked = run(base, cal, { type: "setLocked", id: "a", locked: true }, { type: "setActualDuration", id: "a", days: 4 });
    expect(taskIn(locked, "a").actualDuration).toBe(4);
    const milestone = run(base, cal, { type: "convertMilestone", id: "a", milestone: true });
    expect(applyCommand(milestone, cal, { type: "setActualDuration", id: "a", days: 1 })).toMatchObject({ ok: false, reason: "invalid" });
    expect(applyCommand(base, cal, { type: "setActualDuration", id: "p", days: 1 })).toMatchObject({ ok: false, reason: "invalid" });
    for (const days of [0, 0.3, MAX_DURATION + 1]) {
      expect(applyCommand(base, cal, { type: "setActualDuration", id: "a", days })).toMatchObject({ ok: false, reason: "invalid" });
    }
  });

  it("is cleared when a task becomes a milestone and not copied by duplicating", () => {
    const state = run(base, cal, { type: "setActualDuration", id: "a", days: 5 });
    expect(taskIn(run(state, cal, { type: "convertMilestone", id: "a", milestone: true }), "a").actualDuration).toBeNull();
    expect(taskIn(run(state, cal, { type: "duplicateTask", id: "a", newId: "a2" }), "a2").actualDuration).toBeNull();
  });
});

describe("setLocked", () => {
  it("pins the currently displayed start when locking", () => {
    const state = run(
      project(task("a", { userStart: "2026-10-05", duration: 3 }), task("b", { userStart: "2026-10-05" }), link("a", "b")),
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

describe("addLink", () => {
  const base = project(task("a", { userStart: "2026-10-05", duration: 3 }), task("b", { userStart: "2026-10-06" }));
  const add = (state: ProjectState, predecessorId: string, followerId: string, kind: LinkKind = "FS", lag?: number) =>
    applyCommand(state, cal, { type: "addLink", predecessorId, followerId, kind, ...(lag === undefined ? {} : { lag }) });

  it("makes the follower follow the predecessor, keeping its own start as its \"not before\" date", () => {
    const forward = run(base, cal, { type: "addLink", predecessorId: "a", followerId: "b", kind: "FS" });
    expect(predecessorOf(forward, "b")).toBe("a");
    expect(lagOf(forward, "b")).toBe(0);
    expect(taskIn(forward, "b").userStart).toBe("2026-10-06");
    expect(datesIn(forward, "b")?.start).toBe("2026-10-08");
    // Linked the other way: a (which starts first) now follows b, so it moves after b ends.
    const backward = run(base, cal, { type: "addLink", predecessorId: "b", followerId: "a", kind: "FS" });
    expect(taskIn(backward, "a")).toMatchObject({ userStart: "2026-10-05" });
    expect(predecessorOf(backward, "a")).toBe("b");
    expect(lagOf(backward, "a")).toBe(0);
    expect(predecessorOf(backward, "b")).toBeNull();
    expect(datesIn(backward, "a")?.start).toBe("2026-10-07");
  });

  it("adds a predecessor alongside the existing ones", () => {
    const state = run(
      project(task("x", { userStart: "2026-10-01" }), task("a", { userStart: "2026-10-02" }), task("b", { userStart: "2026-10-06" }), link("x", "b")),
      cal,
      { type: "addLink", predecessorId: "a", followerId: "b", kind: "FS" },
    );
    expect(Object.keys(state.links).sort()).toEqual(["b|a|FS", "b|x|FS"]);
  });

  it("rejects missing tasks, sections, self links, unknown kinds, unscheduled tasks and cycles", () => {
    expect(add(base, "gone", "b")).toMatchObject({ ok: false, reason: "not_found" });
    expect(add(project(section("s"), task("a", { userStart: "2026-10-05" })), "s", "a")).toMatchObject({ ok: false, reason: "invalid" });
    expect(add(base, "a", "a")).toMatchObject({ ok: false, reason: "invalid" });
    expect(add(base, "a", "b", "SF" as LinkKind)).toMatchObject({ ok: false, reason: "invalid" });
    expect(add(project(task("a"), task("b", { userStart: "2026-10-06" })), "a", "b")).toMatchObject({ ok: false, reason: "unscheduled" });
    const chain = project(task("a", { userStart: "2026-10-05" }), task("b", { userStart: "2026-10-06" }), link("a", "b"));
    expect(add(chain, "b", "a", "SS")).toMatchObject({ ok: false, reason: "cycle" });
    // d follows p, so c (inside p) can't wait for d.
    const parentChild = project(task("p"), task("c", { parentId: "p", userStart: "2026-10-06" }), task("d", { userStart: "2026-10-05" }), link("d", "p"));
    expect(add(parentChild, "c", "d")).toMatchObject({ ok: false, reason: "cycle" });
  });

  it("refuses a link to the task's own parent or grandparent, or from a parent to a grandchild", () => {
    const nested = project(task("g"), task("p", { parentId: "g" }), task("c", { parentId: "p", userStart: "2026-10-05" }));
    const refused = { ok: false, reason: "invalid", message: "A task can't link to its own parent or subtask" };
    expect(add(nested, "p", "c")).toMatchObject(refused);
    expect(add(nested, "c", "p", "FF")).toMatchObject(refused);
    expect(add(nested, "c", "g", "SS")).toMatchObject(refused);
    expect(add(nested, "g", "c")).toMatchObject(refused);
  });

  it("allows SS and FF between the same two tasks, but not the same kind twice", () => {
    const state = run(
      base,
      cal,
      { type: "addLink", predecessorId: "a", followerId: "b", kind: "SS" },
      { type: "addLink", predecessorId: "a", followerId: "b", kind: "FF", lag: 1 },
    );
    expect(state.links).toEqual({ "b|a|SS": link("a", "b", 0, "SS"), "b|a|FF": link("a", "b", 1, "FF") });
    expect(add(state, "a", "b", "SS", 2)).toMatchObject({ ok: false, reason: "invalid", message: "These tasks are already linked that way" });
  });

  it("refuses the 51st link into a task", () => {
    const predecessors = Array.from({ length: MAX_LINKS_PER_TASK + 1 }, (_, i) => task(`p${i}`, { userStart: "2026-10-05" }));
    const state = project(
      ...predecessors,
      task("f", { userStart: "2026-10-06" }),
      ...predecessors.slice(0, MAX_LINKS_PER_TASK).map((predecessor) => link(predecessor.id, "f")),
    );
    expect(add(state, `p${MAX_LINKS_PER_TASK}`, "f")).toMatchObject({ ok: false, reason: "invalid" });
    expect(add(state, `p${MAX_LINKS_PER_TASK}`, "p0")).toMatchObject({ ok: true });
  });

  it("refuses invalid lags, and overlaps on anything but FS", () => {
    expect(add(base, "a", "b", "FS", 0.3)).toMatchObject({ ok: false, reason: "invalid" });
    expect(add(base, "a", "b", "SS", -1)).toMatchObject({ ok: false, reason: "invalid", message: "Only “after it finishes” links can overlap" });
    expect(add(base, "a", "b", "FF", -0.5)).toMatchObject({ ok: false, reason: "invalid" });
    const overlapped = run(base, cal, { type: "addLink", predecessorId: "a", followerId: "b", kind: "FS", lag: -1 });
    expect(lagOf(overlapped, "b")).toBe(-1);
    expect(datesIn(overlapped, "b")?.start).toBe("2026-10-07");
  });
});

describe("updateLink", () => {
  const linked = project(
    task("a", { userStart: "2026-10-05", duration: 3 }), // Mon 5 – Wed 7
    task("b", { userStart: "2026-10-05" }), // shown Thu 8
    link("a", "b"),
  );
  const update = (state: ProjectState, fields: { lag?: number; newKind?: LinkKind }, kind: LinkKind = "FS", predecessorId = "a", followerId = "b") =>
    applyCommand(state, cal, { type: "updateLink", predecessorId, followerId, kind, ...fields });

  it("places the task exactly at the new lag", () => {
    const state = run(linked, cal, { type: "updateLink", predecessorId: "a", followerId: "b", kind: "FS", lag: 2 });
    expect(taskIn(state, "b")).toMatchObject({ userStart: "2026-10-12" });
    expect(lagOf(state, "b")).toBe(2);
    const overlapped = run(linked, cal, { type: "updateLink", predecessorId: "a", followerId: "b", kind: "FS", lag: -1 });
    expect(datesIn(overlapped, "b")?.start).toBe("2026-10-07");
  });

  it("clamps an FS lag so the task starts after its predecessor's start", () => {
    const state = run(linked, cal, { type: "updateLink", predecessorId: "a", followerId: "b", kind: "FS", lag: -10 });
    expect(taskIn(state, "b")).toMatchObject({ userStart: "2026-10-06" });
    expect(lagOf(state, "b")).toBe(-2);
  });

  it("refuses a negative SS or FF lag", () => {
    const ss = project(task("a", { userStart: "2026-10-05" }), task("b", { userStart: "2026-10-06" }), link("a", "b", 1, "SS"));
    const refused = { ok: false, reason: "invalid", message: "Only “after it finishes” links can overlap" };
    expect(update(ss, { lag: -1 }, "SS")).toMatchObject(refused);
    expect(update(linked, { lag: -0.5, newKind: "FF" })).toMatchObject(refused);
  });

  it("changes the kind (old key gone, new key present) and re-places the follower", () => {
    const early = project(task("a", { userStart: "2026-10-05", duration: 3 }), task("b", { userStart: "2026-10-01" }), link("a", "b"));
    const ss = run(early, cal, { type: "updateLink", predecessorId: "a", followerId: "b", kind: "FS", newKind: "SS" });
    expect(ss.links).toEqual({ "b|a|SS": link("a", "b", 0, "SS") });
    expect(taskIn(ss, "b").userStart).toBe("2026-10-05");
    expect(datesIn(ss, "b")?.start).toBe("2026-10-05");
    const ff = run(early, cal, { type: "updateLink", predecessorId: "a", followerId: "b", kind: "FS", newKind: "FF" });
    expect(Object.keys(ff.links)).toEqual(["b|a|FF"]);
    expect(taskIn(ff, "b").userStart).toBe("2026-10-07"); // ends with a, on Wed 7
  });

  it("refuses a kind the two tasks are already linked by", () => {
    const both = project(task("a", { userStart: "2026-10-05" }), task("b", { userStart: "2026-10-06" }), link("a", "b"), link("a", "b", 0, "SS"));
    expect(update(both, { newKind: "SS" })).toMatchObject({ ok: false, reason: "invalid", message: "These tasks are already linked that way" });
  });

  it("re-places the follower at the earliest start all its links allow", () => {
    const state = project(
      task("a1", { userStart: "2026-10-05", duration: 3 }), // natural successor start Thu 8
      task("a2", { userStart: "2026-10-05" }),
      task("b", { userStart: "2026-10-01" }),
      link("a1", "b"),
      link("a2", "b", 5, "SS"), // Mon 12
    );
    expect(datesIn(state, "b")?.start).toBe("2026-10-12");
    const updated = run(state, cal, { type: "updateLink", predecessorId: "a2", followerId: "b", kind: "SS", lag: 0 });
    expect(taskIn(updated, "b").userStart).toBe("2026-10-08");
  });

  it("refuses a locked leaf, and a link that doesn't exist", () => {
    const locked = project(task("a", { userStart: "2026-10-05" }), task("b", { userStart: "2026-10-06", locked: true }), link("a", "b"));
    expect(update(locked, { lag: 1 })).toMatchObject({ ok: false, reason: "locked" });
    expect(update(linked, { lag: 1 }, "SS")).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("only changes the link of a parent follower, even a locked one", () => {
    const state = run(
      project(task("a", { userStart: "2026-10-05", duration: 3 }), task("p", { locked: true }), link("a", "p"), task("c", { parentId: "p", userStart: "2026-10-05" })),
      cal,
      { type: "updateLink", predecessorId: "a", followerId: "p", kind: "FS", lag: 1 },
    );
    expect(lagOf(state, "p")).toBe(1);
    expect(taskIn(state, "c").userStart).toBe("2026-10-05");
  });
});

describe("removeLink", () => {
  const linked = project(
    task("a", { userStart: "2026-10-05", duration: 3 }), // Mon 5 – Wed 7
    task("b", { userStart: "2026-10-05" }), // shown Thu 8
    link("a", "b"),
  );
  const remove = (predecessorId: string, followerId: string, kind: LinkKind = "FS") => ({ type: "removeLink" as const, predecessorId, followerId, kind });

  it("keeps the task in place when its predecessor is removed", () => {
    const state = run(linked, cal, remove("a", "b"));
    expect(taskIn(state, "b")).toMatchObject({ userStart: "2026-10-08" });
    expect(predecessorOf(state, "b")).toBeNull();
  });

  it("refuses a link that doesn't exist", () => {
    expect(applyCommand(linked, cal, remove("a", "b", "FF"))).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("keeps a leaf where it is; FF off a parent snaps it back to its subtasks", () => {
    const ss = run(project(task("a", { userStart: "2026-10-05" }), task("b", { userStart: "2026-10-01" }), link("a", "b", 2, "SS")), cal, remove("a", "b", "SS"));
    expect(taskIn(ss, "b").userStart).toBe("2026-10-07");
    const stretched = project(
      task("a", { userStart: "2026-10-05", duration: 5 }), // Mon 5 – Fri 9
      task("p"),
      task("c", { parentId: "p", userStart: "2026-10-05" }),
      link("a", "p", 0, "FF"),
    );
    expect(datesIn(stretched, "p")).toEqual({ start: "2026-10-05", end: "2026-10-09" });
    const state = run(stretched, cal, remove("a", "p", "FF"));
    expect(datesIn(state, "p")).toEqual({ start: "2026-10-05", end: "2026-10-05" });
    expect(state.rows).toEqual(stretched.rows);
  });

  describe("on a parent task", () => {
    const parentLinked = project(
      task("a", { userStart: "2026-10-05", duration: 3 }), // Mon 5 – Wed 7
      task("p"),
      link("a", "p"),
      task("c", { parentId: "p", userStart: "2026-10-05" }), // shown Thu 8
    );

    it("keeps the subtasks in place when the predecessor is removed", () => {
      const state = run(parentLinked, cal, remove("a", "p"));
      expect(predecessorOf(state, "p")).toBeNull();
      expect(datesIn(state, "c")?.start).toBe("2026-10-08");
    });

    it("keeps the subtasks in place when an SS link is removed", () => {
      const state = run(project(task("a", { userStart: "2026-10-05" }), task("p"), link("a", "p", 2, "SS"), task("c", { parentId: "p", userStart: "2026-10-05" })), cal, remove("a", "p", "SS"));
      expect(taskIn(state, "c").userStart).toBe("2026-10-07");
    });

    it("only pins subtasks that the parent's constraint was pushing", () => {
      const state = run(
        project(
          task("a", { userStart: "2026-10-05", duration: 3 }), // Mon 5 – Wed 7
          task("p"),
          link("a", "p"),
          task("c1", { parentId: "p", userStart: "2026-10-05" }), // shown Thu 8
          task("c2", { parentId: "p", userStart: "2026-10-05" }), // shown Fri 9, follows c1
          link("c1", "c2"),
        ),
        cal,
        remove("a", "p"),
      );
      expect(taskIn(state, "c1").userStart).toBe("2026-10-08");
      expect(taskIn(state, "c2").userStart).toBe("2026-10-05");
      expect(datesIn(state, "c2")?.start).toBe("2026-10-09");
      const movedBack = run(state, cal, { type: "moveTask", id: "c1", start: "2026-10-05" });
      expect(datesIn(movedBack, "c2")?.start).toBe("2026-10-06");
    });

    it("keeps the subtasks in place when the predecessor is deleted", () => {
      const state = run(parentLinked, cal, { type: "deleteRows", ids: ["a"] });
      expect(predecessorOf(state, "p")).toBeNull();
      expect(datesIn(state, "c")?.start).toBe("2026-10-08");
    });
  });
});

describe("moveTask with links of every kind", () => {
  it("dragging a follower earlier overlaps every FS link that holds it, and stops at the strictest floor", () => {
    const state = run(
      project(
        task("a1", { userStart: "2026-10-05", duration: 6 }), // Mon 5 – Mon 12
        task("a3", { userStart: "2026-10-05", duration: 5 }), // Mon 5 – Fri 9
        task("a2", { userStart: "2026-10-06", duration: 4 }), // Tue 6 – Fri 9
        task("b", { userStart: "2026-10-05" }), // shown Tue 13
        link("a1", "b"),
        link("a3", "b"),
        link("a2", "b", 1, "FF"),
      ),
      cal,
      { type: "moveTask", id: "b", start: "2026-10-01" },
    );
    // a2's FF floor (end on Fri 9) is stricter than either FS floor (Tue 6).
    expect(taskIn(state, "b").userStart).toBe("2026-10-09");
    expect(datesIn(state, "b")?.start).toBe("2026-10-09");
    expect(state.links).toMatchObject({ "b|a1|FS": { lag: -2 }, "b|a3|FS": { lag: -1 }, "b|a2|FF": { lag: 0 } });
  });

  it("stops at the start of an SS predecessor", () => {
    const state = run(project(task("a", { userStart: "2026-10-06", duration: 2 }), task("b", { userStart: "2026-10-07" }), link("a", "b", 1, "SS")), cal, {
      type: "moveTask",
      id: "b",
      start: "2026-10-01",
    });
    expect(taskIn(state, "b").userStart).toBe("2026-10-06");
    expect(state.links["b|a|SS"]?.lag).toBe(0);
  });

  it("dragging a follower later resets SS/FF lags to 0 and FS lags to 0", () => {
    const state = run(
      project(
        task("a1", { userStart: "2026-10-05" }),
        task("a2", { userStart: "2026-10-05" }),
        task("a3", { userStart: "2026-10-05" }),
        task("b", { userStart: "2026-10-05" }), // shown Wed 7
        link("a1", "b", 1),
        link("a2", "b", 2, "SS"),
        link("a3", "b", 1, "FF"),
      ),
      cal,
      { type: "moveTask", id: "b", start: "2026-10-12" },
    );
    expect(Object.values(state.links).map((l) => l.lag)).toEqual([0, 0, 0]);
    expect(taskIn(state, "b").userStart).toBe("2026-10-12");
    expect(datesIn(state, "b")?.start).toBe("2026-10-12");
  });

  it("a drag keeps the walkthrough's single-FS behaviour", () => {
    const linked = project(task("a", { userStart: "2026-10-05", duration: 3 }), task("b", { userStart: "2026-10-08", duration: 2 }), link("a", "b"));
    // Dragging the bar and dragging its start edge place it the same way.
    const moved = run(linked, cal, { type: "moveTask", id: "b", start: "2026-10-06" });
    const resized = run(linked, cal, { type: "resizeTask", id: "b", edge: "start", date: "2026-10-06" });
    expect(lagOf(moved, "b")).toBe(-2);
    expect(lagOf(resized, "b")).toBe(-2);
    expect(taskIn(moved, "b").userStart).toBe(taskIn(resized, "b").userStart);
    expect(lagOf(run(moved, cal, { type: "moveTask", id: "b", start: "2026-10-12" }), "b")).toBe(0);
  });

  it("drags a parent by its FS and SS links, leaving FF links into it alone", () => {
    const state = run(
      project(
        task("a", { userStart: "2026-10-05", duration: 3 }), // Mon 5 – Wed 7
        task("s", { userStart: "2026-10-06" }),
        task("f", { userStart: "2026-10-05" }),
        task("p"),
        task("c", { parentId: "p", userStart: "2026-10-12" }),
        link("a", "p"),
        link("s", "p", 1, "SS"),
        link("f", "p", 1, "FF"),
      ),
      cal,
      { type: "moveTask", id: "p", start: "2026-10-01" },
    );
    expect(datesIn(state, "c")?.start).toBe("2026-10-06");
    expect(state.links).toMatchObject({ "p|a|FS": { lag: -2 }, "p|s|SS": { lag: 0 }, "p|f|FF": { lag: 1 } });
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
      project(task("p"), task("c", { parentId: "p", userStart: "2026-10-05", duration: 3 }), task("d", { userStart: "2026-10-05" }), link("c", "d")),
      cal,
      { type: "deleteRows", ids: ["p"] },
    );
    expect(Object.keys(state.rows)).toEqual(["d"]);
    expect(taskIn(state, "d")).toMatchObject({ userStart: "2026-10-08" });
    expect(predecessorOf(state, "d")).toBeNull();
  });

  it("deletes every link into or out of deleted rows", () => {
    const state = run(
      project(
        task("a", { userStart: "2026-10-05" }),
        task("b", { userStart: "2026-10-06" }),
        task("c", { userStart: "2026-10-07" }),
        link("a", "b", 0, "SS"),
        link("b", "c", 0, "FF"),
      ),
      cal,
      { type: "deleteRows", ids: ["b"] },
    );
    expect(state.links).toEqual({});
  });

  it("deleting a task that is predecessor and follower in several links, then undoing, brings every link back", () => {
    const before = project(
      task("x", { userStart: "2026-10-05" }),
      task("y", { userStart: "2026-10-05" }),
      task("b", { userStart: "2026-10-05", duration: 2 }), // Tue 6 – Wed 7
      task("c", { userStart: "2026-10-05" }), // shown Thu 8
      task("d", { userStart: "2026-10-05" }), // shown Wed 7
      link("x", "b"),
      link("y", "b", 1, "SS"),
      link("b", "c"),
      link("b", "d", 0, "FF"),
    );
    const result = applyCommand(before, cal, { type: "deleteRows", ids: ["b"] });
    if (!result.ok) throw new Error(result.message);
    expect(result.state.links).toEqual({});
    expect(taskIn(result.state, "c").userStart).toBe("2026-10-08");
    expect(taskIn(result.state, "d").userStart).toBe("2026-10-07");
    expect(revertChanges(result.state, result.changes, "undo")).toEqual({ state: before, skipped: 0 });
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

  it("duplicateTask copies what it waits on, not what waits on it", () => {
    const state = run(
      project(task("x", { userStart: "2026-10-05" }), task("a", { userStart: "2026-10-06" }), task("y", { userStart: "2026-10-07" }), link("x", "a", -0.5), link("x", "a", 1, "SS"), link("a", "y", 0, "FF")),
      cal,
      { type: "duplicateTask", id: "a", newId: "a2" },
    );
    expect(Object.values(state.links).filter((l) => l.followerId === "a2")).toEqual([link("x", "a2", -0.5), link("x", "a2", 1, "SS")]);
    expect(Object.values(state.links).filter((l) => l.predecessorId === "a2")).toEqual([]);
  });

  it("indenting a task under its own predecessor removes that link and keeps its dates", () => {
    const state = run(
      project(task("a", { userStart: "2026-10-05", duration: 3 }), task("b", { userStart: "2026-10-05" }), link("a", "b"), link("a", "b", 1, "SS")), // b shown Thu 8
      cal,
      { type: "indent", id: "b" },
    );
    expect(taskIn(state, "b").parentId).toBe("a");
    expect(state.links).toEqual({});
    expect(taskIn(state, "b").userStart).toBe("2026-10-08");
    expect(datesIn(state, "b")?.start).toBe("2026-10-08");
  });

  it("moving a task into the parent that follows it removes that link", () => {
    const state = run(
      project(task("x", { userStart: "2026-10-05", duration: 5 }), task("p"), task("c", { parentId: "p", userStart: "2026-10-05" }), link("x", "p", 0, "FF"), link("x", "c", 0, "SS")),
      cal,
      { type: "moveRow", id: "x", parentId: "p", afterId: "c" },
    );
    expect(Object.keys(state.links)).toEqual(["c|x|SS"]);
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
