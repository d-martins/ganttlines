import { toDay, weekday } from "@ganttlines/engine";
import { describe, expect, it } from "vitest";
import { elbow } from "../src/board/chart/dependencies";
import { chartRange, Timeline } from "../src/board/chart/timeline";
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
    const { visible, numbers } = outline({
      rows: {
        s: section("s", { position: "a0", collapsed: true }),
        a: task("a", { parentId: "s", position: "a0" }),
        b: task("b", { position: "b0" }),
        c: task("c", { parentId: "b", position: "a0" }),
      },
    });
    expect(visible.map((entry) => [entry.row.id, entry.number, entry.depth])).toEqual([
      ["s", 1, 0],
      ["b", 3, 0],
      ["c", 4, 1],
    ]);
    expect(numbers.get("a")).toBe(2);
    expect(visible[1]!.isParent).toBe(true);
  });
});

describe("list and arrows", () => {
  it("writes predecessors as row number and offset", () => {
    const numbers = new Map([["p", 3]]);
    const entry = (offset: number) => ({ row: task("t", { predecessorId: "p", offset }) }) as BoardRow;
    expect(predecessorText(entry(0), numbers)).toBe("#3");
    expect(predecessorText(entry(2), numbers)).toBe("#3 +2");
    expect(predecessorText(entry(-1), numbers)).toBe("#3 −1");
  });

  it("routes arrows straight when there is room, around when the successor starts earlier", () => {
    expect(elbow(100, 15, 140, 45, 30)).toBe("M100,15 H108 V45 H140");
    expect(elbow(100, 15, 90, 45, 30)).toBe("M100,15 H108 V30 H82 V45 H90");
  });
});
