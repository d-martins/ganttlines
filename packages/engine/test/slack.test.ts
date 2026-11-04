import { describe, expect, it } from "vitest";
import { linkKey } from "../src/links";
import type { ProjectState, Row } from "../src/model";
import { computeSchedule } from "../src/schedule";
import { computeSlack, criticalLinks, effectiveTarget } from "../src/slack";
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
    ["cutoff", 2, { kind: "end" }],
    ["legal", 0, { kind: "end" }],
    ["release", 0, { kind: "end" }],
  ])("the example plan: %s has %d days", (id, expected, limit) => {
    expect(slackOf(example()).get(id)).toEqual({ halves: expected * 2, limit });
  });

  it("with no targets at all, measures to the end of the board", () => {
    const state = project(task("a", { userStart: start, duration: 2 }), task("long", { userStart: start, duration: 5 }));
    expect(slackOf(state).get("a")).toEqual({ halves: 6, limit: { kind: "end" } });
    expect(days(state, "long")).toBe(0);
  });

  it("a board with one task has 0", () => {
    expect(days(project(task("a", { userStart: start })), "a")).toBe(0);
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
      task("p", { parentId: "s", userStart: start }),
      task("k1", { parentId: "p", userStart: start, duration: 1 }),
      task("k2", { parentId: "p", userStart: start, duration: 3 }),
      task("idle", { parentId: "s" }),
      task("far", { userStart: start, duration: 5 }),
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
    const state = project(task("a", { userStart: start, duration: 1.5 }), task("far", { userStart: start, duration: 3 }));
    expect(slackOf(state).get("a")?.halves).toBe(3);
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
    expect(Date.now() - began).toBeLessThan(1000);
    expect(slack.get("t0")?.halves).toBe(0);
  });
});

describe("criticalLinks", () => {
  it("returns only links the slip passes through at 0 or below", () => {
    const state = example();
    const schedule = computeSchedule(state, cal);
    const critical = criticalLinks(state, cal, schedule, computeSlack(state, cal, schedule));
    expect(critical).toEqual(new Set([linkKey(link("design", "api")), linkKey(link("legal", "release"))]));
  });
});
