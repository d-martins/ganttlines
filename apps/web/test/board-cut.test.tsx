import { halfDay, spanOfHalves, toDay, type Span } from "@ganttlines/engine";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clampCut, resumeAt, useCutting } from "../src/board/chart/cutting";
import { useChartDrag } from "../src/board/chart/drag";
import { useBoardView } from "../src/board/view-store";
import { DAY_WIDTH } from "../src/board/chart/timeline";
import { task } from "./board-fixtures";
import { board, sentCommands } from "./chart-board";
import { screen, VIEWER } from "./utils";

const MON = "2026-10-12";
const am = (iso: string) => halfDay(toDay(iso));
const pm = (iso: string) => halfDay(toDay(iso), true);
const part = (from: number, to: number): Span => spanOfHalves(from, to);

describe("clampCut", () => {
  const whole = [part(am(MON), pm("2026-10-14"))];

  it("never before the first half day's end, however far left", () => {
    expect(clampCut(am("2026-01-01"), whole)).toBe(pm(MON));
    expect(clampCut(am(MON), whole)).toBe(pm(MON));
  });

  it("never past the last half day", () => {
    expect(clampCut(am("2027-01-01"), whole)).toBe(pm("2026-10-14"));
  });

  it("inside stays where it is", () => {
    expect(clampCut(am("2026-10-13"), whole)).toBe(am("2026-10-13"));
  });

  it("in a gap goes to the nearest part", () => {
    const parts = [part(am(MON), pm(MON)), part(am("2026-10-16"), pm("2026-10-16"))];
    expect(clampCut(am("2026-10-13"), parts)).toBe(pm(MON));
    expect(clampCut(pm("2026-10-15"), parts)).toBe(am("2026-10-16"));
  });
});

describe("resumeAt", () => {
  it("later than the cut, or nothing", () => {
    expect(resumeAt(am("2026-10-16"), am("2026-10-13"))).toBe(am("2026-10-16"));
    expect(resumeAt(am("2026-10-13"), am("2026-10-13"))).toBeNull();
    expect(resumeAt(am(MON), am("2026-10-13"))).toBeNull();
  });
});

describe("cutting a bar", () => {
  const icon = () => screen.getByRole("button", { name: /^Interrupt “t”/ });
  const chartX = (iso: string) => (toDay(iso) - toDay("2026-10-12")) * 32 + barLeft();
  let barLeft: () => number;
  const at = (x: number) => fireEvent.pointerMove(window, { clientX: x, clientY: 0 });
  const press = (x: number) => {
    fireEvent.pointerDown(window, { button: 0, clientX: x, clientY: 0 });
    fireEvent.pointerUp(window, { button: 0, clientX: x, clientY: 0 });
    fireEvent.click(document.body, { clientX: x });
  };
  const cuts = () => sentCommands().filter((command) => command.type === "addBreak");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 1, 12));
    barLeft = () => parseFloat(screen.getByRole("button", { name: /^t, / }).style.left);
  });
  afterEach(() => {
    vi.useRealTimers();
    useChartDrag.setState({ drag: null });
    useCutting.setState({ rowId: null, cut: null, line: null });
  });

  it("has the icon with the bar's tools, and not on what can't be cut", async () => {
    await board([task("t", { userStart: MON, duration: 2 }), task("m", { userStart: MON, duration: 0 }), task("up", { userStart: MON }), task("kid", { userStart: MON, parentId: "up" }), task("locked", { userStart: MON, locked: true })]);
    expect(icon()).toBeEnabled();
    for (const name of ["m", "up", "locked"]) expect(screen.queryByRole("button", { name: new RegExp(`^Interrupt “${name}”`) })).not.toBeInTheDocument();
  });

  it("is off for half-day tasks, which have nothing to cut", async () => {
    await board([task("t", { userStart: MON, duration: 0.5 })]);
    expect(icon()).toBeDisabled();
  });

  it("viewers don't get it", async () => {
    await board([task("t", { userStart: MON, duration: 2 })], VIEWER);
    expect(screen.queryByRole("button", { name: /^Interrupt/ })).not.toBeInTheDocument();
  });

  it("click the icon, click to cut, move, click: one interruption", async () => {
    await board([task("t", { userStart: MON, duration: 2 })]);
    fireEvent.click(icon());
    expect(await screen.findByTestId("cut-line")).toBeInTheDocument();
    at(chartX("2026-10-13"));
    press(chartX("2026-10-13"));
    expect(useCutting.getState().cut).toBe(am("2026-10-13"));
    expect(screen.queryByTestId("cut-line")).not.toBeInTheDocument();
    at(chartX("2026-10-16"));
    expect(useChartDrag.getState().drag?.command).toEqual({ type: "addBreak", id: "t", from: "2026-10-13", fromHalf: "morning", resume: "2026-10-16", resumeHalf: "morning" });
    expect(cuts()).toEqual([]);
    press(chartX("2026-10-16"));
    await waitFor(() => expect(cuts()).toHaveLength(1));
    expect(useCutting.getState().rowId).toBeNull();
    expect(useChartDrag.getState().drag).toBeNull();
  });

  it("the line stops inside the bar, however far the pointer goes", async () => {
    await board([task("t", { userStart: MON, duration: 2 })]);
    fireEvent.click(icon());
    at(-5000);
    expect(useCutting.getState().line).toBe(pm(MON));
    at(50000);
    expect(useCutting.getState().line).toBe(pm("2026-10-13"));
  });

  it("landing back where it was cut sends nothing", async () => {
    await board([task("t", { userStart: MON, duration: 2 })]);
    fireEvent.click(icon());
    at(chartX("2026-10-13"));
    press(chartX("2026-10-13"));
    at(chartX("2026-10-13"));
    expect(useChartDrag.getState().drag?.command ?? null).toBeNull();
    press(chartX("2026-10-13"));
    expect(cuts()).toEqual([]);
    expect(useCutting.getState().rowId).toBeNull();
  });

  it("Esc cancels at either step", async () => {
    await board([task("t", { userStart: MON, duration: 2 })]);
    fireEvent.click(icon());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useCutting.getState().rowId).toBeNull();
    fireEvent.click(icon());
    at(chartX("2026-10-13"));
    press(chartX("2026-10-13"));
    at(chartX("2026-10-16"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useCutting.getState().rowId).toBeNull();
    expect(useChartDrag.getState().drag).toBeNull();
    expect(cuts()).toEqual([]);
  });

  it("clicks while cutting don't reach the board", async () => {
    await board([task("t", { userStart: MON, duration: 2 }), task("other", { userStart: MON })]);
    fireEvent.click(icon());
    const other = screen.getByRole("button", { name: /^other, / });
    fireEvent.pointerDown(other, { button: 0, clientX: chartX("2026-10-13"), clientY: 0 });
    fireEvent.pointerUp(window, { button: 0, clientX: chartX("2026-10-13"), clientY: 0 });
    expect(useCutting.getState().cut).toBe(pm(MON) + 1);
    expect(sentCommands().filter((command) => command.type === "moveTask")).toEqual([]);
  });

  it("at a wider zoom it cuts in whole days", async () => {
    await board([task("t", { userStart: MON, duration: 3 })]);
    const before = useBoardView.getState().dayWidth;
    useBoardView.setState({ dayWidth: DAY_WIDTH.week });
    fireEvent.click(await screen.findByRole("button", { name: /^Interrupt “t”/ }));
    at(barLeft() + DAY_WIDTH.week * 1.8);
    expect(useCutting.getState().line).toBe(am("2026-10-13"));
    useCutting.setState({ rowId: null, line: null, cut: null });
    useBoardView.setState({ dayWidth: before });
  });
});
