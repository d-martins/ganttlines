import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChartDrag, useHoveredRow } from "../src/board/chart/drag";
import { board, sentCommands } from "./chart-board";
import { screen, VIEWER } from "./utils";
import { PROJECT_ID, task } from "./board-fixtures";
import { useCriticalPathView } from "../src/board/critical-path-view";

const MON = "2026-10-12";

const split = { userStart: MON, duration: 2, breaks: [{ after: 2, length: 6 }] };
const parts = () => screen.queryAllByTestId("bar-part");
const gaps = () => screen.queryAllByTestId("bar-gap");
const left = (element: Element) => parseFloat((element as HTMLElement).style.left);

describe("bars in parts", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 1, 12));
  });
  afterEach(() => {
    vi.useRealTimers();
    useChartDrag.setState({ drag: null });
    useHoveredRow.setState({ id: null });
  });

  it("draws one element per part, with a gap between", async () => {
    await board([task("t", split)]);
    expect(parts()).toHaveLength(2);
    expect(gaps()).toHaveLength(1);
    expect(left(gaps()[0]!)).toBeGreaterThan(left(parts()[0]!));
    expect(left(gaps()[0]!)).toBeLessThan(left(parts()[1]!));
  });

  it("a bar in one part is drawn as before", async () => {
    await board([task("t", { userStart: MON, duration: 2 })]);
    expect(parts()).toEqual([]);
    expect(gaps()).toEqual([]);
    expect(screen.getByRole("button", { name: /^t, / })).toBeInTheDocument();
  });

  it("the first part is the bar for keyboard and screen readers; the title sits after the last", async () => {
    await board([task("t", split)]);
    const shape = screen.getByRole("button", { name: /^t, / });
    expect(shape).toBe(parts()[0]);
    expect(shape).toHaveAttribute("tabindex", "0");
    expect(parts()[1]).toHaveAttribute("aria-hidden", "true");
    const title = within(shape.parentElement!).getByText("t");
    expect(left(title.parentElement!)).toBeGreaterThan(left(parts()[1]!));
  });

  it("a holiday inside the bar splits it; a weekend alone doesn't", async () => {
    await board([task("holiday", { userStart: "2026-10-02", duration: 2 }), task("weekend", { userStart: "2026-10-16", duration: 2 })]); // Oct 5 is a holiday
    expect(parts()).toHaveLength(2);
    expect(gaps()).toHaveLength(1);
  });

  it("every part carries the status outline", async () => {
    await board([task("t", { ...split, targetId: "m" }), task("m", { userStart: "2026-10-13", duration: 0 })]);
    expect(parts().map((part) => part.getAttribute("data-slack"))).toEqual(["late", "late"]);
  });

  it("an overrun is drawn after the last part", async () => {
    await board([task("t", { ...split, actualDuration: 3 })]);
    expect(left(screen.getByTestId("actual-over"))).toBeGreaterThan(left(parts()[1]!));
  });

  it("planned days not needed are dimmed only inside the last part", async () => {
    await board([task("t", { userStart: MON, duration: 3, breaks: [{ after: 2, length: 6 }], actualDuration: 2 })]);
    const dim = screen.getByTestId("actual-under");
    expect(left(dim)).toBeGreaterThan(left(parts()[1]!));
  });

  it("none at all when it wouldn't fit in the last part", async () => {
    await board([task("t", { ...split, actualDuration: 0.5 })]);
    expect(screen.queryByTestId("actual-under")).not.toBeInTheDocument();
  });

  it("a bar split only by a holiday draws an overrun after its last part", async () => {
    await board([task("t", { userStart: "2026-10-02", duration: 2, actualDuration: 3 })]); // Oct 5 is a holiday
    expect(parts()).toHaveLength(2);
    expect(left(screen.getByTestId("actual-over"))).toBeGreaterThan(left(parts()[1]!));
  });

  it("a bar split only by a holiday doesn't dim across its gap", async () => {
    await board([task("t", { userStart: "2026-10-02", duration: 2, actualDuration: 1 })]);
    expect(parts()).toHaveLength(2);
    expect(screen.queryByTestId("actual-under")).not.toBeInTheDocument();
  });

  it("critical arrows don't show on a baseline's dates", async () => {
    const { dependencyColor } = await import("../src/board/chart/dependencies");
    expect(dependencyColor({ violation: false, critical: true, fromBaseline: true })).toBe("var(--dependency)");
    expect(dependencyColor({ violation: false, critical: true, fromBaseline: false })).toBe("var(--slack-zero)");
  });

  it("gap edges have handles; holiday and interrupter gaps don't", async () => {
    await board([task("t", split)]);
    expect(screen.getAllByTestId("gap-edge")).toHaveLength(2);
  });

  it("no handles beside a holiday gap", async () => {
    await board([task("t", { userStart: "2026-10-02", duration: 2 })]);
    expect(parts()).toHaveLength(2);
    expect(screen.queryAllByTestId("gap-edge")).toEqual([]);
  });

  it("no handles beside a gap from another task", async () => {
    await board([task("a", { userStart: "2026-10-13", duration: 3 }), task("b", { userStart: MON, duration: 2, interruptedBy: ["a"] })]);
    expect(parts()).toHaveLength(2);
    expect(screen.queryAllByTestId("gap-edge")).toEqual([]);
  });

  it("viewers get no handles", async () => {
    await board([task("t", split)], VIEWER);
    expect(screen.queryAllByTestId("gap-edge")).toEqual([]);
  });

  it("dragging a gap's edge previews, and resizes it on the drop", async () => {
    await board([task("t", split)]);
    const edge = screen.getAllByTestId("gap-edge")[0]!;
    const x = left(edge) + 3;
    fireEvent.pointerDown(edge, { button: 0, clientX: x, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: x + 32, clientY: 0 });
    expect(useChartDrag.getState().drag?.command).toMatchObject({ type: "resizeBreak", id: "t", after: 2, edge: "start" });
    fireEvent.pointerUp(window, { clientX: x + 32, clientY: 0 });
    await waitFor(() => expect(sentCommands().at(-1)).toMatchObject({ type: "resizeBreak", id: "t", after: 2, edge: "start", date: "2026-10-13" }));
  });

  it("dragging the other edge moves that one", async () => {
    await board([task("t", split)]);
    const edge = screen.getAllByTestId("gap-edge")[1]!;
    const x = left(edge) + 3;
    fireEvent.pointerDown(edge, { button: 0, clientX: x, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: x - 32, clientY: 0 });
    await waitFor(() => expect(sentCommands().at(-1)).toMatchObject({ type: "resizeBreak", id: "t", after: 2, edge: "end", date: "2026-10-15" }));
  });

  it("dragging any part moves the whole task", async () => {
    await board([task("t", split)]);
    const part = parts()[1]!;
    const x = left(part) + 10;
    fireEvent.pointerDown(part, { button: 0, clientX: x, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: x + 32, clientY: 0 });
    await waitFor(() => expect(sentCommands().at(-1)).toMatchObject({ type: "moveTask", id: "t", start: "2026-10-13" }));
  });

  it("an interruption shows dashed lines only while either task is hovered", async () => {
    await board([task("a", { userStart: "2026-10-13", duration: 3 }), task("b", { userStart: MON, duration: 2, interruptedBy: ["a"] }), task("other", { userStart: MON })]);
    const row = (index: number) => document.querySelector(`[data-row="${index}"]`)!;
    expect(screen.queryByTestId("interruption")).not.toBeInTheDocument();
    fireEvent.pointerEnter(row(0));
    expect((await screen.findAllByTestId("interruption"))[0]).toHaveAttribute("stroke-dasharray");
    fireEvent.pointerLeave(row(0));
    await waitFor(() => expect(screen.queryByTestId("interruption")).not.toBeInTheDocument());
    fireEvent.pointerEnter(row(1));
    expect(await screen.findAllByTestId("interruption")).toHaveLength(2);
    fireEvent.pointerLeave(row(1));
    fireEvent.pointerEnter(row(2));
    await waitFor(() => expect(screen.queryByTestId("interruption")).not.toBeInTheDocument());
  });

  const lineXs = () => screen.queryAllByTestId("interruption").map((line) => {
    const [, x1, x2] = /^M([\d.]+),[\d.]+ V[\d.]+$/.exec(line.getAttribute("d")!) ?? [];
    return Number(x1 ?? x2 ?? NaN);
  });
  const hover = (index: number) => fireEvent.pointerEnter(document.querySelector(`[data-row="${index}"]`)!);

  it("the lines run straight down from each edge of the gap", async () => {
    await board([task("a", { userStart: "2026-10-13", duration: 3 }), task("b", { userStart: MON, duration: 2, interruptedBy: ["a"] })]);
    hover(0);
    await screen.findAllByTestId("interruption");
    const [first, second] = parts();
    const right = left(first!) + parseFloat((first as HTMLElement).style.width);
    expect(lineXs()).toEqual([right, left(second!)]);
  });

  it("each part of the interrupting task gets its own pair", async () => {
    await board([task("a", { userStart: "2026-10-13", duration: 2, breaks: [{ after: 2, length: 2 }] }), task("b", { userStart: MON, duration: 3, interruptedBy: ["a"] })]);
    hover(0);
    await screen.findAllByTestId("interruption");
    expect(lineXs()).toHaveLength(4);
  });

  it("no gap, no lines", async () => {
    await board([task("a", { userStart: "2026-11-16", duration: 1 }), task("b", { userStart: MON, duration: 2, interruptedBy: ["a"] })]);
    hover(0);
    await waitFor(() => expect(useHoveredRow.getState().id).toBe("a"));
    expect(screen.queryByTestId("interruption")).not.toBeInTheDocument();
  });

  it("with Critical path on, an interruption with no room shows when hovered, in the critical colour", async () => {
    useCriticalPathView.setState({ on: { [PROJECT_ID]: true }, defaults: {} });
    try {
      await board([task("a", { userStart: MON, duration: 1 }), task("b", { userStart: "2026-10-13", duration: 2, interruptedBy: ["a"], targetId: "m" }), task("m", { userStart: "2026-10-14", duration: 0 })]);
      expect(screen.queryByTestId("interruption")).not.toBeInTheDocument();
      hover(0);
      const line = await screen.findByTestId("interruption");
      expect(line).toHaveAttribute("stroke", "var(--slack-zero)");
      expect(line).toHaveAttribute("data-critical");
    } finally {
      useCriticalPathView.setState({ on: {}, defaults: {} });
    }
  });

  it("with it off, nothing to see", async () => {
    useCriticalPathView.setState({ on: { [PROJECT_ID]: false }, defaults: {} });
    try {
      await board([task("a", { userStart: MON, duration: 1 }), task("b", { userStart: "2026-10-13", duration: 2, interruptedBy: ["a"], targetId: "m" }), task("m", { userStart: "2026-10-14", duration: 0 })]);
      hover(0);
      await waitFor(() => expect(useHoveredRow.getState().id).toBe("a"));
      expect(screen.queryByTestId("interruption")).not.toBeInTheDocument();
    } finally {
      useCriticalPathView.setState({ on: {}, defaults: {} });
    }
  });

  it("a baseline's parts draw as parts, and an old snapshot still draws", async () => {
    const { baselineGhostSegments } = await import("../src/board/chart/bars");
    const span = { start: 10, end: 20, startsAfternoon: false, endsMidday: false };
    expect(baselineGhostSegments({ kind: "task", span })).toEqual([span]);
    const parts = [{ ...span, end: 12 }, { ...span, start: 18 }];
    expect(baselineGhostSegments({ kind: "task", span, parts })).toEqual(parts);
  });
});
