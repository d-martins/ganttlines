import { Calendar, linkKey, toDay, weekday, type Change, type Link } from "@ganttlines/engine";
import type { ActivityEntryDto } from "@ganttlines/protocol";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { elbow } from "../src/board/chart/dependencies";
import { lineOf, linkOf, type LinkLine } from "../src/board/link-phrases";
import { describeChange, describeEntry } from "../src/board/panel/activity";
import { chartRange, Timeline } from "../src/board/chart/timeline";
import { dropMove } from "../src/board/list/list-actions";
import { durations } from "../src/board/list/task-list";
import { NO_FILTERS } from "../src/board/filters";
import { boardModel } from "../src/board/model";
import { outline } from "../src/board/rows";
import { ANA, CALENDAR, section, task } from "./board-fixtures";

const FRI = toDay("2026-10-09");
const weekend = (day: number) => weekday(day) === 0 || weekday(day) === 6;

describe("history of links", () => {
  const names = { state: { rows: { p: task("p", { title: "Design" }), f: task("f", { title: "Build" }) }, links: {} }, resources: new Map() };
  const ref = { predecessorId: "p", followerId: "f", kind: "FS" as const };
  const created = (lag: number, kind: Link["kind"] = "FS") => ({ link: { ...ref, kind }, field: "*" as const, before: null, after: { ...ref, kind, lag } });
  const removed = { link: ref, field: "*" as const, before: { ...ref, lag: 0 }, after: null };
  const lag = { link: ref, field: "lag" as const, before: 0, after: 3 };

  it("describeChange phrases for follower and predecessor", () => {
    expect(describeChange(created(0), names, "f")).toBe("now waits on “Design”, after it finishes");
    expect(describeChange(created(2), names, "f")).toBe("now waits on “Design”, after it finishes, 2 days later");
    expect(describeChange(created(-1.5), names, "f")).toBe("now waits on “Design”, after it finishes, overlapping 1.5 days");
    expect(describeChange(created(0, "SS"), names, "f")).toBe("now waits on “Design”, once it starts");
    expect(describeChange(created(1, "SF"), names, "f")).toBe("now waits on “Design”, can't finish before it starts, 1 day later");
    expect(describeChange(created(0, "SF"), names, "p")).toBe("“Build” now waits on it, can't finish before it starts");
    expect(describeChange(removed, names, "f")).toBe("no longer waits on “Design”");
    expect(describeChange(lag, names, "f")).toBe("changed the delay after “Design” to 3 days");
    expect(describeChange(created(2, "FF"), names, "p")).toBe("“Build” now waits on it, can't finish before it finishes");
    expect(describeChange(removed, names, "p")).toBe("“Build” no longer waits on it");
    expect(describeChange(lag, names, "p")).toBe("changed the delay of “Build”'s link to 3 days");
    expect(describeChange({ ...lag, after: -2 }, names, "f")).toBe("now overlaps “Design” by 2 days");
    expect(describeChange({ ...lag, after: -2 }, names, "p")).toBe("“Build” now overlaps it by 2 days");
    expect(describeChange({ ...lag, after: 0 }, names, "f")).toBe("now starts right after “Design”");
    expect(describeChange({ ...lag, after: 0 }, names, "p")).toBe("“Build” now starts right after it");
    const ssLag = { ...lag, link: { ...ref, kind: "SS" as const }, after: 0 };
    expect(describeChange(ssLag, names, "f")).toBe("changed the delay after “Design” to none");
    expect(describeChange(ssLag, names, "p")).toBe("changed the delay of “Build”'s link to none");
    const gone = { ...names, state: { rows: { f: names.state.rows.f }, links: {} } };
    expect(describeChange(removed, gone, "f")).toBe("no longer waits on a deleted task");
  });

  it("a kind change reads as one phrase", () => {
    const toSS = [removed, created(0, "SS")];
    const entry = (changes: Change[], name = "updateLink") => ({ version: 1, name, actor: { label: "Ana" }, createdAt: "2026-10-01T00:00:00Z", changes }) as ActivityEntryDto;
    expect(describeEntry(entry(toSS), names, "f")).toBe("changed the link with “Design” to “once it starts” (was “after it finishes”)");
    expect(describeEntry(entry(toSS), names, "p")).toBe("“Build”'s link to it is now “once it starts”");
    const toSF = [removed, created(0, "SF")];
    expect(describeEntry(entry(toSF), names, "f")).toBe("changed the link with “Design” to “can't finish before it starts” (was “after it finishes”)");
    // Created first, deleted second (as an undo may log it): still one kind change.
    expect(describeEntry(entry([...toSS].reverse(), "undo"), names, "f")).toBe("undid a change (changed the link with “Design” to “once it starts” (was “after it finishes”))");
  });
});

describe("history of a turned-around link", () => {
  const names = { state: { rows: { p: task("p", { title: "Design" }), f: task("f", { title: "Build" }) }, links: {} }, resources: new Map() };
  const was = { predecessorId: "p", followerId: "f", kind: "FS" as const };
  const removed = { link: was, field: "*" as const, before: { ...was, lag: 0 }, after: null };
  const turned = (kind: Link["kind"], lag = 0) => {
    const ref = { predecessorId: "f", followerId: "p", kind };
    return { link: ref, field: "*" as const, before: null, after: { ...ref, lag } };
  };
  const entry = (changes: Change[], name = "updateLink") => ({ version: 1, name, actor: { label: "Ana" }, createdAt: "2026-10-01T00:00:00Z", changes }) as ActivityEntryDto;

  it("reads as one change, from either task", () => {
    // Design now waits on Build.
    expect(describeEntry(entry([removed, turned("FS")]), names, "f")).toBe("turned the link with “Design” around: now “Design” waits on it, after it finishes");
    expect(describeEntry(entry([removed, turned("FS", 1)]), names, "p")).toBe("turned the link with “Build” around: now waits on “Build”, after it finishes, 1 day later");
    expect(describeEntry(entry([removed, turned("SF")]), names, "f")).toBe("turned the link with “Design” around: now “Design” waits on it, can't finish before it starts");
    expect(describeEntry(entry([turned("SF"), removed], "undo"), names, "p")).toBe("undid a change (turned the link with “Build” around: now waits on “Build”, can't finish before it starts)");
  });
});

describe("link lines", () => {
  // [this task …] the other task [… ], and the link it means: its kind and whether this task waits.
  const TABLE: [LinkLine["when"], LinkLine["end"], Link["kind"], boolean][] = [
    ["starts after", "finished", "FS", true],
    ["starts after", "started", "SS", true],
    ["ends after", "finished", "FF", true],
    ["ends after", "started", "SF", true],
    ["ends before", "started", "FS", false],
    ["starts before", "started", "SS", false],
    ["ends before", "finished", "FF", false],
    ["starts before", "finished", "SF", false],
  ];

  it("reads each of the eight lines as a kind and a direction", () => {
    for (const [when, end, kind, thisWaits] of TABLE) expect(linkOf({ when, end })).toEqual({ kind, thisWaits });
  });

  it("writes each kind and direction as its line", () => {
    for (const [when, end, kind, thisWaits] of TABLE) expect(lineOf({ kind, thisWaits })).toEqual({ when, end });
  });
});

describe("durations", () => {
  const calendar = new Calendar(CALENDAR);
  // Ana works Tue 6, Thu 8, Fri 9 (Wed 7 off): the parent's and section's dates cover 4 team days.
  const state = {
    rows: {
      s: section("s"),
      p: task("p", { parentId: "s" }),
      c: task("c", { parentId: "p", resourceId: ANA.id, userStart: "2026-10-06", duration: 3 }),
    },
    links: {},
  };
  const working = (model: ReturnType<typeof boardModel>, id: string) => durations(model.rows.find((entry) => entry.row.id === id)!, calendar).working;

  it("parents and sections count only the days their tasks are worked", () => {
    const model = boardModel(state, calendar, null);
    expect(working(model, "p")).toBe("3");
    expect(working(model, "s")).toBe("3");
    expect(working(model, "c")).toBe("3");
  });

  it("a baseline's parent keeps counting across its saved dates", () => {
    const tasks = [
      { rowId: "p", kind: "parent" as const, title: "p", start: "2026-10-06", end: "2026-10-09" },
      { rowId: "c", kind: "task" as const, title: "c", start: "2026-10-06", end: "2026-10-09" },
    ];
    const model = boardModel(state, calendar, { mode: "switch", tasks });
    expect(working(model, "p")).toBe("4");
  });
});

describe("Timeline", () => {
  it("maps days to pixels, inclusive of the end day", () => {
    const timeline = new Timeline(FRI, FRI + 10, 10);
    expect(timeline.x(FRI + 2)).toBe(20);
    expect(timeline.xEnd(FRI + 2)).toBe(30);
    expect(timeline.width).toBe(110);
    expect(timeline.dayAt(25)).toBe(FRI + 2);
  });

  it("gives hidden days no width and maps them to the next visible day", () => {
    const timeline = new Timeline(FRI, FRI + 10, 10, weekend);
    expect(timeline.x(FRI + 3)).toBe(10); // Monday right after Friday
    expect(timeline.x(FRI + 1)).toBe(10); // Saturday → Monday's edge
    expect(timeline.xEnd(FRI + 3) - timeline.x(FRI)).toBe(20); // Fri–Mon is two columns
    expect(timeline.daysBetween(0, 30)).toEqual([FRI, FRI + 3, FRI + 4]);
  });

  it("clamps days outside its range", () => {
    const timeline = new Timeline(FRI, FRI + 10, 10);
    expect(timeline.x(FRI - 50)).toBe(0);
    expect(timeline.xEnd(FRI + 50)).toBe(110);
    expect(timeline.xEnd(FRI - 50)).toBe(0);
  });

  it("covers today and every date, starting on a Monday", () => {
    const { first, last } = chartRange([FRI + 200, FRI - 100], FRI);
    expect(weekday(first)).toBe(1);
    expect(first).toBeLessThanOrEqual(FRI - 100);
    expect(last).toBeGreaterThanOrEqual(FRI + 200);
  });
});

describe("outline", () => {
  it("numbers every row depth-first and leaves out children of collapsed rows", () => {
    const { visible, numbers } = outline(
      {
        rows: {
          s: section("s", { position: "a0" }),
          a: task("a", { parentId: "s", position: "a0" }),
          b: task("b", { position: "b0" }),
          c: task("c", { parentId: "b", position: "a0" }),
        },
        links: {},
      },
      undefined,
      new Set(["s"]),
    );
    expect(visible.map((entry) => [entry.row.id, entry.number, entry.depth])).toEqual([
      ["s", 1, 0],
      ["b", 3, 0],
      ["c", 4, 1],
    ]);
    expect(numbers.get("a")).toBe(2);
    expect(visible[0]!.collapsed).toBe(true);
    expect(visible[1]!.isParent).toBe(true);
  });
});

describe("board model", () => {
  it("boardModel lists links between shown rows and marks the violated one", () => {
    const fs: Link = { predecessorId: "a", followerId: "b", kind: "FS", lag: 0 };
    // Locked to start the day after "a" starts, before it finishes: the FS link is broken, the SS one holds.
    const ss: Link = { predecessorId: "a", followerId: "b", kind: "SS", lag: 0 };
    const hidden: Link = { predecessorId: "a", followerId: "c", kind: "FS", lag: 0 };
    const state = {
      rows: {
        a: task("a", { position: "a0", userStart: "2026-10-12", duration: 3 }),
        b: task("b", { position: "a1", userStart: "2026-10-13", duration: 1, locked: true }),
        s: section("s", { position: "a2" }),
        c: task("c", { parentId: "s", position: "a0", userStart: "2026-10-20" }),
      },
      links: Object.fromEntries([fs, ss, hidden].map((link) => [linkKey(link), link])),
    };
    const model = boardModel(state, new Calendar(CALENDAR), null, NO_FILTERS, new Set(["s"]));
    expect(model.rows.map((entry) => entry.row.id)).toEqual(["a", "b", "s"]);
    expect(model.links).toEqual(
      expect.arrayContaining([
        { link: fs, violation: true },
        { link: ss, violation: false },
      ]),
    );
    expect(model.links).toHaveLength(2); // "c" is collapsed away: its link isn't drawn
  });
});

describe("list and arrows", () => {
  it("routes arrows out of the predecessor's bottom or top into the successor's left side", () => {
    const pred = { left: 40, right: 100, y: 15, half: 7 };
    // successor starts after the predecessor ends: drop near the predecessor's end
    expect(elbow(pred, { left: 140, y: 45 }, 30)).toBe("M92,22 V45 H140");
    // successor above: leave from the top edge
    expect(elbow({ ...pred, y: 45 }, { left: 140, y: 15 }, 30)).toBe("M92,38 V15 H140");
    // overlapping successor: drop further left so the arrow still arrives from the left
    expect(elbow(pred, { left: 70, y: 45 }, 30)).toBe("M62,22 V45 H70");
    // successor starts before there's room: go round between the rows
    expect(elbow(pred, { left: 44, y: 45 }, 30)).toBe("M70,22 V30 H36 V45 H44");
  });
});

describe("list width", () => {
  it("never narrows the list below its columns", async () => {
    const { useBoardView, LIST_WIDTH } = await import("../src/board/view-store");
    useBoardView.getState().setListWidth(250);
    expect(useBoardView.getState().listWidth).toBe(LIST_WIDTH.min);
    expect(LIST_WIDTH.min).toBe(40 + 96 + 120 + 40 + 40 + 76 + 8); // actions: three icon buttons (14 px), 4 px apart
  });
});

describe("list edits", () => {
  it("turns drops into moves: before, inside and after a row", () => {
    const state = {
      rows: {
        s: section("s", { position: "a0" }),
        a: task("a", { parentId: "s", position: "a0" }),
        b: task("b", { parentId: "s", position: "a1" }),
        c: task("c", { position: "b0" }),
      },
      links: {},
    };
    expect(dropMove(state, "c", state.rows.b, "before")).toEqual({ parentId: "s", afterId: "a" });
    expect(dropMove(state, "c", state.rows.a, "before")).toEqual({ parentId: "s", afterId: null });
    expect(dropMove(state, "c", state.rows.a, "inside")).toEqual({ parentId: "a", afterId: null });
    expect(dropMove(state, "a", state.rows.c, "after")).toEqual({ parentId: null, afterId: "c" });
    expect(dropMove(state, "s", state.rows.a, "inside")).toBeNull(); // into itself
    expect(dropMove(state, "b", state.rows.a, "after")).toBeNull(); // already there
    const withSection = { rows: { ...state.rows, t: section("t", { position: "c0" }) }, links: {} };
    expect(dropMove(withSection, "t", withSection.rows.a, "inside")).toEqual({ parentId: "s", afterId: "a" }); // sections never go inside tasks: lands after it
  });
});

describe("chart drags", () => {
  it("turns pointer travel into moves and resizes, snapping to visible days", async () => {
    const { dragCommand, stepDay } = await import("../src/board/chart/drag");
    const timeline = new Timeline(FRI, FRI + 20, 10, weekend);
    const span = { start: FRI, end: FRI + 3, startsAfternoon: false, endsMidday: false }; // Fri → Mon
    expect(dragCommand("move", "t", span, timeline, 4, 0)).toBeNull(); // less than half a column
    expect(dragCommand("move", "t", span, timeline, 10, 0)).toMatchObject({ type: "moveTask", start: "2026-10-12" }); // Fri → Mon, weekend skipped
    expect(dragCommand("end", "t", span, timeline, 0, 25)).toMatchObject({ type: "resizeTask", edge: "end", date: "2026-10-13" });
    expect(dragCommand("end", "t", span, timeline, 0, 0)).toMatchObject({ date: "2026-10-09" }); // never before the start
    expect(dragCommand("start", "t", span, timeline, 0, 5)).toBeNull(); // Friday: where it already starts
    expect(dragCommand("start", "t", span, timeline, 0, 15)).toMatchObject({ type: "resizeTask", edge: "start", date: "2026-10-12" });
    expect(stepDay(timeline, FRI, 1)).toBe(FRI + 3);
    expect(stepDay(timeline, FRI + 3, -1)).toBe(FRI);
  });

  it("snaps to half columns at day zoom, and keeps a task's half at wider zooms", async () => {
    const { dragCommand, stepHalf } = await import("../src/board/chart/drag");
    const { halfDay } = await import("@ganttlines/engine");
    const day = new Timeline(FRI, FRI + 20, 32, weekend); // day zoom: 16 px half columns
    const span = { start: FRI, end: FRI + 3, startsAfternoon: false, endsMidday: false }; // Fri → Mon
    expect(dragCommand("move", "t", span, day, 7, 0)).toBeNull(); // under half a half-column
    expect(dragCommand("move", "t", span, day, 9, 0)).toMatchObject({ type: "moveTask", start: "2026-10-09", half: "afternoon" });
    expect(dragCommand("end", "t", span, day, 0, 32 + 10)).toMatchObject({ type: "resizeTask", edge: "end", date: "2026-10-12", half: "morning" }); // Mon morning
    expect(dragCommand("start", "t", span, day, 0, 20)).toMatchObject({ type: "resizeTask", edge: "start", date: "2026-10-09", half: "afternoon" });
    expect(stepHalf(day, halfDay(FRI, true), 1)).toBe(halfDay(FRI + 3)); // Fri pm → Mon am
    expect(stepHalf(day, halfDay(FRI + 3), -1)).toBe(halfDay(FRI, true));
    const week = new Timeline(FRI, FRI + 20, 10, weekend);
    const afternoon = { ...span, startsAfternoon: true };
    expect(dragCommand("move", "t", afternoon, week, 10, 0)).toMatchObject({ start: "2026-10-12", half: "afternoon" });
    expect(stepHalf(week, halfDay(FRI, true), 1)).toBe(halfDay(FRI + 3, true));
  });
});

describe("drag auto-scroll", () => {
  it("pushes harder the closer the pointer is to (or past) an edge", async () => {
    const { edgePush } = await import("../src/board/auto-scroll");
    expect(edgePush(500, 100, 900)).toBe(0);
    expect(edgePush(880, 100, 900)).toBe(0.5);
    expect(edgePush(1000, 100, 900)).toBe(1); // past the edge: full speed forward
    expect(edgePush(120, 100, 900)).toBe(-0.5);
    expect(edgePush(0, 100, 900)).toBe(-1);
  });
});

describe("lingering rows", () => {
  const ids = (...list: string[]) => new Set(list);
  const linger = async (initial: { matches: Set<string>; focused: string | null }) => {
    const { renderHook } = await import("@testing-library/react");
    const { useLinger } = await import("../src/board/linger");
    return renderHook(({ matches, focused }) => useLinger(matches, focused), { initialProps: initial });
  };
  afterEach(() => vi.useRealTimers());

  it("keeps a focused row that stops matching, until 5 s after focus leaves", async () => {
    vi.useFakeTimers();
    const hook = await linger({ matches: ids("a", "b"), focused: "a" });
    hook.rerender({ matches: ids("b"), focused: "a" });
    expect([...hook.result.current].sort()).toEqual(["a", "b"]);
    act(() => vi.advanceTimersByTime(60_000)); // still focused: still kept
    expect(hook.result.current.has("a")).toBe(true);
    hook.rerender({ matches: ids("b"), focused: "b" });
    act(() => vi.advanceTimersByTime(4_900));
    expect(hook.result.current.has("a")).toBe(true);
    act(() => vi.advanceTimersByTime(200));
    expect([...hook.result.current]).toEqual(["b"]);
  });

  it("a row that matches again stays, and isn't removed later", async () => {
    vi.useFakeTimers();
    const hook = await linger({ matches: ids("a"), focused: "a" });
    hook.rerender({ matches: ids(), focused: "a" });
    hook.rerender({ matches: ids(), focused: null });
    act(() => vi.advanceTimersByTime(2_000));
    hook.rerender({ matches: ids("a"), focused: null });
    act(() => vi.advanceTimersByTime(10_000));
    hook.rerender({ matches: ids("a"), focused: null });
    expect([...hook.result.current]).toEqual(["a"]);
  });

  it("a changed filter doesn't keep the focused row", async () => {
    const { renderHook } = await import("@testing-library/react");
    const { useLinger } = await import("../src/board/linger");
    const hook = renderHook(({ matches, scope }) => useLinger(matches, "a", 5000, scope), { initialProps: { matches: ids("a", "b"), scope: "q=x" } });
    hook.rerender({ matches: ids("b"), scope: "q=y" });
    expect([...hook.result.current]).toEqual(["b"]);
  });

  it("a row that stops matching without focus leaves straight away", async () => {
    const hook = await linger({ matches: ids("a", "b"), focused: "b" });
    hook.rerender({ matches: ids("b"), focused: "b" });
    expect([...hook.result.current]).toEqual(["b"]);
  });
});
