import { describe, expect, it } from "vitest";
import { linkKey } from "../src/links";
import type { ProjectState, Row } from "../src/model";
import { computeSchedule } from "../src/schedule";
import { toDay } from "../src/date";
import { analyseSlack, Clock, computeSlack, effectiveTarget } from "../src/slack";
import { calendar, link, project, section, task } from "./fixtures";

// October 2026: Mon 5 … Fri 9, Mon 12 … Fri 16, Mon 19 … Fri 23, Mon 26 … Fri 30
const cal = calendar();
const start = "2026-10-05";
const slackOf = (state: ProjectState, c = cal) => computeSlack(state, c, computeSchedule(state, c));
const days = (state: ProjectState, id: string, c = cal) => {
  const slack = slackOf(state, c).get(id);
  return slack ? slack.halves / 2 : null;
};

// The risk that's the point of all this: two separate limits on one board.
const example = () =>
  project(
    task("design", { userStart: start, duration: 3 }),
    task("api", { userStart: start, duration: 9, targetId: "cutoff" }),
    task("ui", { userStart: "2026-10-08", duration: 7, targetId: "cutoff" }),
    task("docs", { userStart: "2026-10-12", duration: 3, targetId: "cutoff" }),
    task("cutoff", { userStart: "2026-10-20", duration: 0 }),
    task("qa", { userStart: start, duration: 4 }),
    task("package", { userStart: start, duration: 1 }),
    task("legal", { userStart: start, duration: 19 }),
    task("release", { userStart: start, duration: 0 }),
    link("design", "api"),
    link("cutoff", "qa"),
    link("qa", "package"),
    link("package", "release"),
    link("legal", "release"),
  );

describe("computeSlack", () => {
  it.each([
    ["design", 0, { kind: "milestone", id: "cutoff" }],
    ["api", 0, { kind: "milestone", id: "cutoff" }],
    ["ui", 2, { kind: "milestone", id: "cutoff" }],
    ["docs", 4, { kind: "milestone", id: "cutoff" }],
    ["qa", 2, { kind: "end" }],
    ["package", 2, { kind: "end" }],
    ["legal", 0, { kind: "end" }],
  ])("the example plan: %s has %d days", (id, expected, limit) => {
    expect(slackOf(example()).get(id)).toEqual({ halves: expected * 2, limit });
  });

  it("milestones never have a number, whatever they're connected to, and don't count towards a parent's", () => {
    expect(slackOf(example()).has("cutoff")).toBe(false);
    expect(slackOf(example()).has("release")).toBe(false);
    const state = project(
      task("p", { userStart: start }),
      task("kid", { parentId: "p", userStart: start, duration: 1, targetId: "m" }),
      task("gate", { parentId: "p", userStart: "2026-10-05", duration: 0 }),
      task("m", { userStart: "2026-10-09", duration: 0 }),
      link("gate", "kid", 0, "SS"),
    );
    expect(slackOf(state).has("gate")).toBe(false);
    expect(days(state, "p")).toBe(4);
  });

  it("a task connected to nothing has no number: no aim, no links, nobody aiming at it", () => {
    const state = project(task("a", { userStart: start, duration: 2 }), task("long", { userStart: start, duration: 5 }), task("m", { userStart: "2026-10-30", duration: 0 }));
    expect(slackOf(state).size).toBe(0);
  });

  it("a chain with no milestones measures to the end of the board, the rest stays out", () => {
    const state = project(task("a", { userStart: start, duration: 2 }), task("b", { userStart: start, duration: 1 }), task("alone", { userStart: start, duration: 9 }), link("a", "b"));
    expect(slackOf(state).get("a")).toEqual({ halves: 12, limit: { kind: "end" } }); // b may slip to the 15th, the board's last day
    expect(slackOf(state).get("b")).toEqual({ halves: 12, limit: { kind: "end" } });
    expect(slackOf(state).has("alone")).toBe(false);
  });

  it("a subtask of a linked parent has a number, and so does the parent", () => {
    const state = project(
      task("t", { userStart: start, duration: 1, targetId: "m" }),
      task("m", { userStart: "2026-10-09", duration: 0 }),
      task("p", { userStart: start }),
      task("kid", { parentId: "p", userStart: start, duration: 1 }),
      task("before", { userStart: start, duration: 1 }),
      link("before", "p"),
    );
    expect(slackOf(state).has("kid")).toBe(true);
    expect(slackOf(state).has("p")).toBe(true);
  });

  describe("through a link: the most the predecessor can shift without pushing the follower past its own limit", () => {
    const board = (...items: Parameters<typeof project>) =>
      project(
        task("a", { userStart: start, duration: 2 }),
        task("b", { userStart: start, duration: 1, targetId: "m" }),
        task("m", { userStart: "2026-10-16", duration: 0 }),
        task("far", { userStart: start, duration: 60 }),
        ...items,
      );

    it.each([
      ["FS with lag 2", link("a", "b", 2, "FS"), 5],
      ["FS with lag -1", link("a", "b", -1, "FS"), 8],
      ["SS", link("a", "b", 0, "SS"), 9],
      ["FF", link("a", "b", 0, "FF"), 8],
      ["SF", link("a", "b", 0, "SF"), 10],
    ])("%s", (_name, joined, expected) => {
      const state = board(joined);
      expect(days(state, "a")).toBe(expected);
      expect(slackOf(state).get("a")?.limit).toEqual({ kind: "milestone", id: "m" });
    });

    it("a follower placed later than needed absorbs the gap first", () => {
      const state = project(
        task("a", { userStart: start, duration: 1 }),
        task("b", { userStart: "2026-10-12", duration: 1, targetId: "m" }),
        task("m", { userStart: "2026-10-16", duration: 0 }),
        link("a", "b"),
      );
      expect(days(state, "b")).toBe(4);
      expect(days(state, "a")).toBe(8); // b may start on the 16th, so a may finish on the 15th
    });

    it("a locked follower limits at its current position", () => {
      const state = project(
        task("a", { userStart: start, duration: 1 }),
        task("b", { userStart: "2026-10-08", duration: 1, locked: true }),
        task("far", { userStart: start, duration: 30 }),
        link("a", "b"),
      );
      expect(slackOf(state).get("a")).toEqual({ halves: 4, limit: { kind: "task", id: "b" } });
    });

    it("into a parent, the link holds all its subtasks", () => {
      const state = project(
        task("a", { userStart: start, duration: 1 }),
        task("p", { userStart: start }),
        task("k1", { parentId: "p", userStart: start, duration: 1, targetId: "m" }),
        task("k2", { parentId: "p", userStart: "2026-10-15", duration: 1 }),
        task("m", { userStart: "2026-10-09", duration: 0 }),
        task("far", { userStart: start, duration: 30 }),
        link("a", "p"),
      );
      expect(days(state, "k1")).toBe(3); // Tue 6 to Fri 9
      expect(days(state, "a")).toBe(3);
    });

    it("FF into a parent is limited by what the parent's end can reach", () => {
      const state = project(
        task("a", { userStart: start, duration: 1 }),
        task("p", { userStart: start }),
        task("k", { parentId: "p", userStart: start, duration: 1 }),
        task("after", { userStart: "2026-10-09", duration: 1, locked: true }),
        task("far", { userStart: start, duration: 30 }),
        link("a", "p", 0, "FF"),
        link("p", "after"),
      );
      expect(days(state, "a")).toBe(3); // the parent may stretch to Thu 8
    });

    it("out of a parent, only the subtask setting its end is limited by it", () => {
      const state = project(
        task("p", { userStart: start }),
        task("late", { parentId: "p", userStart: start, duration: 3 }),
        task("early", { parentId: "p", userStart: start, duration: 1 }),
        task("after", { userStart: start, duration: 1, targetId: "m" }),
        task("m", { userStart: "2026-10-09", duration: 0 }),
        task("far", { userStart: start, duration: 30 }),
        link("p", "after"),
      );
      expect(days(state, "after")).toBe(1); // Thu 8 to Fri 9
      expect(days(state, "late")).toBe(1);
      expect(days(state, "early")).toBe(3); // catches up with `late`, then the same 1 day
    });
  });

  it("a subtask not setting its parent's end isn't charged for a late follower", () => {
    const state = project(
      task("p", { userStart: start }),
      task("late", { parentId: "p", userStart: start, duration: 3 }),
      task("early", { parentId: "p", userStart: start, duration: 1 }),
      task("after", { userStart: start, duration: 1, targetId: "m" }),
      task("m", { userStart: "2026-10-07", duration: 0 }),
      task("far", { userStart: start, duration: 30 }),
      link("p", "after"),
    );
    expect(days(state, "after")).toBe(-1);
    expect(days(state, "late")).toBe(-1);
    expect(days(state, "early")).toBe(1); // it can reach the Tuesday the parent has to end on
    expect(days(state, "p")).toBe(-1);
  });

  it("a miss bigger than the board is counted in full", () => {
    const state = project(task("a", { userStart: start, duration: 1 }), task("b", { userStart: "2026-10-06", duration: 1, locked: true }), link("a", "b", 20));
    expect(days(state, "a")).toBe(-20);
  });

  it("a milestone doesn't inherit its parent's target", () => {
    const state = project(
      task("p", { userStart: start, targetId: "soon" }),
      task("kid", { parentId: "p", userStart: start, duration: 1 }),
      task("inside", { parentId: "p", userStart: "2026-10-20", duration: 0 }),
      task("soon", { userStart: "2026-10-07", duration: 0 }),
    );
    expect(slackOf(state).has("inside")).toBe(false);
    expect(days(state, "kid")).toBe(2);
  });

  it("a target already passed gives a negative number, and so do tasks feeding it", () => {
    const state = project(
      task("feeder", { userStart: start, duration: 1 }),
      task("late", { userStart: start, duration: 5, targetId: "m" }),
      task("m", { userStart: "2026-10-07", duration: 0 }),
      link("feeder", "late"),
    );
    expect(slackOf(state).get("late")).toEqual({ halves: -6, limit: { kind: "milestone", id: "m" } });
    expect(slackOf(state).get("feeder")).toEqual({ halves: -6, limit: { kind: "milestone", id: "m" } });
  });

  it("a parent's target covers its subtasks, and a subtask's own replaces it", () => {
    const state = project(
      task("p", { userStart: start, targetId: "soon" }),
      task("inherits", { parentId: "p", userStart: start, duration: 1 }),
      task("own", { parentId: "p", userStart: start, duration: 1, targetId: "later" }),
      task("soon", { userStart: "2026-10-07", duration: 0 }),
      task("later", { userStart: "2026-10-09", duration: 0 }),
      task("far", { userStart: start, duration: 30 }),
    );
    expect(slackOf(state).get("inherits")).toEqual({ halves: 4, limit: { kind: "milestone", id: "soon" } });
    expect(slackOf(state).get("own")).toEqual({ halves: 8, limit: { kind: "milestone", id: "later" } });
    expect(effectiveTarget(state, state.rows["inherits"] as Row)).toBe("soon");
    expect(effectiveTarget(state, state.rows["own"] as Row)).toBe("later");
    expect(effectiveTarget(state, state.rows["far"] as Row)).toBeNull();
  });

  it("a parent shows the tightest of its subtasks; sections and unscheduled tasks have no entry", () => {
    const state = project(
      section("s"),
      task("p", { parentId: "s", userStart: start, targetId: "m" }),
      task("k1", { parentId: "p", userStart: start, duration: 1 }),
      task("k2", { parentId: "p", userStart: start, duration: 3 }),
      task("idle", { parentId: "s" }),
      task("m", { userStart: "2026-10-09", duration: 0 }),
    );
    expect(days(state, "p")).toBe(2);
    expect(slackOf(state).has("s")).toBe(false);
    expect(slackOf(state).has("idle")).toBe(false);
  });

  it("an undated target sets no limit", () => {
    const state = project(task("a", { userStart: start, targetId: "m" }), task("m", { duration: 0 }), task("far", { userStart: start, duration: 3 }));
    expect(slackOf(state).get("a")).toEqual({ halves: 4, limit: { kind: "end" } });
  });

  it("half days return odd halves", () => {
    const state = project(task("a", { userStart: start, duration: 1.5, targetId: "m" }), task("m", { userStart: "2026-10-09", duration: 0 }));
    expect(slackOf(state).get("a")?.halves).toBe(7);
  });

  it("an assignee's time off isn't counted", () => {
    const off = calendar({ timeOff: [{ id: "off", resourceId: "r", startDate: "2026-10-07", endDate: "2026-10-09" }] });
    const state = project(
      task("free", { userStart: start, duration: 1, targetId: "m" }),
      task("busy", { userStart: start, duration: 1, resourceId: "r", targetId: "m" }),
      task("m", { userStart: "2026-10-16", duration: 0 }),
    );
    expect(days(state, "free", off)).toBe(9);
    expect(days(state, "busy", off)).toBe(6);
  });

  it("2,000 tasks in a chain run under a second without overflowing", () => {
    const rows = Array.from({ length: 2000 }, (_, index) => task(`t${index}`, { userStart: start, duration: 1 }));
    const links = rows.slice(1).map((row, index) => link(`t${index}`, row.id));
    const state = project(...rows, ...links);
    const schedule = computeSchedule(state, cal);
    const began = Date.now();
    const slack = computeSlack(state, cal, schedule);
    const took = Date.now() - began;
    expect(took).toBeLessThan(1000);
    expect(slack.get("t0")?.halves).toBe(0);
  });
});

describe("analyseSlack", () => {
  it("names only the links a slip passes straight through", () => {
    const state = example();
    expect(analyseSlack(state, cal, computeSchedule(state, cal)).critical).toEqual(new Set([linkKey(link("design", "api")), linkKey(link("legal", "release"))]));
  });

  it("knows who is past their own target, even when something else is tighter", () => {
    const state = project(
      task("t", { userStart: start, duration: 3, targetId: "m" }),
      task("m", { userStart: "2026-10-06", duration: 0 }),
      task("locked", { userStart: "2026-10-06", duration: 1, locked: true }),
      task("fine", { userStart: start, duration: 1, targetId: "m" }),
      link("t", "locked"),
    );
    const { slack, pastTarget } = analyseSlack(state, cal, computeSchedule(state, cal));
    expect(slack.get("t")?.limit).toEqual({ kind: "task", id: "locked" });
    expect(pastTarget).toEqual(new Set(["t"]));
  });
});

describe("how long it takes", () => {
  it("a stray far-off date with many people doesn't slow it down", () => {
    const people = Array.from({ length: 60 }, (_, i) => `r${i}`);
    const off = calendar({ timeOff: people.map((id) => ({ id, resourceId: id, startDate: "2026-11-20", endDate: "2026-11-21" })) });
    const state = project(...people.map((id) => task(id, { userStart: "2026-11-02", duration: 2, resourceId: id, targetId: "m" })), task("m", { userStart: "2026-12-01", duration: 0 }), task("stray", { userStart: "2199-01-01" }));
    const schedule = computeSchedule(state, off);
    const before = Date.now();
    computeSlack(state, off, schedule);
    expect(Date.now() - before).toBeLessThan(600);
  });

  it("its clock agrees with walking the calendar", () => {
    const off = calendar({
      holidays: [{ id: "h", name: "h", startDate: "2026-10-12", endDate: "2026-10-13", appliesTo: "all" }],
      timeOff: [{ id: "o", resourceId: "ana", startDate: "2026-10-21", endDate: "2026-10-22" }],
    });
    for (const resource of [null, "ana"]) {
      const clock = new Clock(off, resource);
      const from = toDay("2026-10-01") * 2;
      for (let half = from; half < from + 80; half++) {
        for (const other of [from, from + 37, from + 79]) {
          const [a, b] = [off.snapHalf(half, resource), off.snapHalf(other, resource)];
          expect(clock.between(a, b)).toBe(off.workingHalvesBetween(a, b, resource));
        }
        for (const n of [-40, -3, -1, 0, 1, 2, 9, 60]) expect(clock.add(half, n)).toBe(off.addWorkingHalves(off.snapHalf(half, resource), n, resource));
      }
    }
  });

  it("gives the same answers as walking the calendar", () => {
    const off = calendar({ holidays: [{ id: "h", name: "h", startDate: "2026-10-12", endDate: "2026-10-13", appliesTo: "all" }], timeOff: [{ id: "o", resourceId: "ana", startDate: "2026-10-21", endDate: "2026-10-22" }] });
    const state = project(
      task("a", { userStart: "2026-10-05", duration: 3, resourceId: "ana", targetId: "m" }),
      task("b", { userStart: "2026-10-08", duration: 12.5, resourceId: "ana" }),
      task("m", { userStart: "2026-10-30", duration: 0 }),
      task("after", { userStart: "2026-10-05", duration: 2 }),
      link("a", "b"),
      link("b", "after"),
    );
    const slack = slackOf(state, off);
    expect(slack.get("after")?.limit).toEqual({ kind: "end" });
  });
});

describe("across parts and interruptions", () => {
  const MON = "2026-10-05";

  it("a split task slips from its last part", () => {
    // Monday and Friday, aiming for the Monday after.
    const state = project(task("t", { userStart: MON, duration: 2, breaks: [{ after: 2, length: 6 }], targetId: "m" }), task("m", { userStart: "2026-10-12", duration: 0 }));
    expect(days(state, "t")).toBe(1);
  });

  it("an interrupter inside its task has room: the gap just moves", () => {
    const state = project(task("a", { userStart: "2026-10-06", duration: 1 }), task("b", { userStart: MON, duration: 3, interruptedBy: ["a"], targetId: "m" }), task("m", { userStart: "2026-10-08", duration: 0 }));
    expect(slackOf(state).get("a")?.limit).not.toEqual({ kind: "milestone", id: "m" });
  });

  it("an interrupter limits when slipping would push the interrupted task past its own limit", () => {
    // A on Monday, B on Wednesday and Thursday with no room: A can reach Tuesday, but not into Wednesday.
    const state = project(task("a", { userStart: MON, duration: 1 }), task("b", { userStart: "2026-10-07", duration: 2, interruptedBy: ["a"], targetId: "m" }), task("m", { userStart: "2026-10-08", duration: 0 }));
    expect(slackOf(state).get("b")).toMatchObject({ halves: 0 });
    expect(slackOf(state).get("a")).toEqual({ halves: 2, limit: { kind: "milestone", id: "m" } });
  });

  it("an interrupter's time off doesn't count as it running", () => {
    const off = calendar({ timeOff: [{ id: "o", resourceId: "ana", startDate: "2026-10-07", endDate: "2026-10-07" }] });
    // A on Tuesday and Thursday, Ana off Wednesday. B on Monday and Wednesday has no room. A slipping only frees Tuesday for B.
    const state = project(task("a", { userStart: "2026-10-06", duration: 2, resourceId: "ana" }), task("b", { userStart: MON, duration: 2, resourceId: "rui", interruptedBy: ["a"], targetId: "m" }), task("m", { userStart: "2026-10-07", duration: 0 }));
    const schedule = computeSchedule(state, off);
    expect(computeSlack(state, off, schedule).get("b")).toMatchObject({ halves: 0 });
    expect(computeSlack(state, off, schedule).get("a")?.limit).toEqual({ kind: "end" });
  });

  it("stays quick on very long interrupted tasks", () => {
    const interrupters = Array.from({ length: 20 }, (_, i) => task(`a${i}`, { userStart: "2020-01-06", duration: 2 + i }));
    const interrupted = Array.from({ length: 20 }, (_, i) => task(`b${i}`, { userStart: MON, duration: 3600, interruptedBy: interrupters.map((row) => row.id) }));
    const state = project(...interrupters, ...interrupted);
    const schedule = computeSchedule(state, cal);
    const before = Date.now();
    computeSlack(state, cal, schedule);
    expect(Date.now() - before).toBeLessThan(5000);
  });

  it("names the interruptions with no room", () => {
    const tight = project(task("a", { userStart: MON, duration: 1 }), task("b", { userStart: "2026-10-06", duration: 2, interruptedBy: ["a"], targetId: "m" }), task("m", { userStart: "2026-10-07", duration: 0 }));
    expect([...analyseSlack(tight, cal, computeSchedule(tight, cal)).criticalInterruptions]).toEqual(["a|b"]);
    const roomy = project(task("a", { userStart: MON, duration: 1 }), task("b", { userStart: "2026-10-06", duration: 2, interruptedBy: ["a"], targetId: "m" }), task("m", { userStart: "2026-10-20", duration: 0 }));
    expect([...analyseSlack(roomy, cal, computeSchedule(roomy, cal)).criticalInterruptions]).toEqual([]);
  });

  it("an interruption connects a task", () => {
    const state = project(task("a", { userStart: MON, duration: 1 }), task("b", { userStart: MON, duration: 2, interruptedBy: ["a"] }), task("loose", { userStart: MON, duration: 1 }));
    expect(slackOf(state).get("a")).toBeDefined();
    expect(slackOf(state).get("b")).toBeDefined();
    expect(slackOf(state).get("loose")).toBeUndefined();
  });

  it("a locked task ignores interrupters, so it's no limit", () => {
    const state = project(task("a", { userStart: MON, duration: 1 }), task("b", { userStart: "2026-10-07", duration: 2, locked: true, interruptedBy: ["a"], targetId: "m" }), task("m", { userStart: "2026-10-08", duration: 0 }));
    expect(slackOf(state).get("a")).toBeUndefined();
  });
});
