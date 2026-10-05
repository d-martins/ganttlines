import { toDay, weekday } from "@ganttlines/engine";
import { describe, expect, it } from "vitest";
import { elbow } from "../src/board/chart/dependencies";
import { chartRange, Timeline } from "../src/board/chart/timeline";
import { dropMove } from "../src/board/list/list-actions";
import { predecessorText } from "../src/board/list/task-list";
import type { BoardRow } from "../src/board/model";
import { outline } from "../src/board/rows";
import { section, task } from "./board-fixtures";

const FRI = toDay("2026-10-09");
const weekend = (day: number) => weekday(day) === 0 || weekday(day) === 6;

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

describe("list and arrows", () => {
  it("writes predecessors as their row number only (offsets are never shown)", () => {
    const numbers = new Map([["p", 3]]);
    const entry = (offset: number) => ({ row: task("t", { predecessorId: "p", offset }) }) as BoardRow;
    expect(predecessorText(entry(0), numbers)).toBe("#3");
    expect(predecessorText(entry(-8), numbers)).toBe("#3");
  });

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
    expect(LIST_WIDTH.min).toBe(40 + 96 + 120 + 40 + 40 + 56 + 48 + 8);
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
    };
    expect(dropMove(state, "c", state.rows.b, "before")).toEqual({ parentId: "s", afterId: "a" });
    expect(dropMove(state, "c", state.rows.a, "before")).toEqual({ parentId: "s", afterId: null });
    expect(dropMove(state, "c", state.rows.a, "inside")).toEqual({ parentId: "a", afterId: null });
    expect(dropMove(state, "a", state.rows.c, "after")).toEqual({ parentId: null, afterId: "c" });
    expect(dropMove(state, "s", state.rows.a, "inside")).toBeNull(); // into itself
    expect(dropMove(state, "b", state.rows.a, "after")).toBeNull(); // already there
    const withSection = { rows: { ...state.rows, t: section("t", { position: "c0" }) } };
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
