import { act, fireEvent } from "@testing-library/react";
import { useSelection } from "../src/board/selection";
import { describe, expect, it } from "vitest";
import { LIST_WIDTH, listContentWidth, mostRowActions, rowActionsWidth, useBoardView } from "../src/board/view-store";
import { task } from "./board-fixtures";
import { board } from "./chart-board";
import { screen, VIEWER } from "./utils";

describe("the task list's width", () => {
  it("keeps every column: the content is as wide as the columns need, the task name at least 200 px", () => {
    expect(listContentWidth(false)).toBe(40 + 200 + 120 + 40 + 40 + 58 + 8);
    expect(listContentWidth(true)).toBe(listContentWidth(false) + 72);
    expect(listContentWidth(false, 2)).toBe(40 + 200 + 120 + 40 + 40 + 40 + 8);
  });

  it("sizes the actions column to the most actions a row can show: 14 px icons, 4 px apart, 8 px before them", () => {
    expect([1, 2, 3].map(rowActionsWidth)).toEqual([22, 40, 58]);
  });

  it("counts the actions: show on chart always, expand/collapse all inside when a row has nested rows inside, delete for editors", () => {
    const flat = [{ id: "a", parentId: null }, { id: "b", parentId: "a" }];
    const nested = [{ id: "a", parentId: null }, { id: "b", parentId: "a" }, { id: "c", parentId: "b" }];
    expect(mostRowActions(flat, true)).toBe(2);
    expect(mostRowActions(flat, false)).toBe(1);
    expect(mostRowActions(nested, true)).toBe(3);
    expect(mostRowActions(nested, false)).toBe(2);
  });

  it("an editor's board with no nested rows gets a two-action column", async () => {
    await board([task("t", { userStart: "2026-10-12" })]);
    expect(screen.getByRole("treegrid", { name: "Tasks" }).style.getPropertyValue("--actions-width")).toBe("40px");
  });

  it("a row with nested rows inside makes room for the third action", async () => {
    await board([task("a", { userStart: "2026-10-12" }), task("b", { parentId: "a", userStart: "2026-10-12" }), task("c", { parentId: "b", userStart: "2026-10-12" })]);
    expect(screen.getByRole("treegrid", { name: "Tasks" }).style.getPropertyValue("--actions-width")).toBe("58px");
  });

  it("a viewer, who can't delete, gets one action's room", async () => {
    await board([task("t", { userStart: "2026-10-12" })], VIEWER);
    expect(screen.getByRole("treegrid", { name: "Tasks" }).style.getPropertyValue("--actions-width")).toBe("22px");
  });

  it("can be made narrower than the columns, and starts wide enough for them", () => {
    expect(LIST_WIDTH.min).toBeLessThan(listContentWidth(false));
    expect(LIST_WIDTH.initial).toBeGreaterThanOrEqual(listContentWidth(false));
    useBoardView.getState().setListWidth(10);
    expect(useBoardView.getState().listWidth).toBe(LIST_WIDTH.min);
  });

  it("wide enough: no scrollbar, nothing pinned", async () => {
    await board([task("t", { userStart: "2026-10-12" })]);
    expect(screen.queryByTestId("list-scrollbar")).not.toBeInTheDocument();
    expect(screen.getByRole("gridcell", { name: "Row 1" })).not.toHaveAttribute("data-pinned");
  });

  it("narrower: a scrollbar under the list moves the columns, and the actions stay put", async () => {
    useBoardView.getState().setListWidth(300);
    await board([task("t", { userStart: "2026-10-12" })]);
    const bar = screen.getByTestId("list-scrollbar");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe(`${listContentWidth(false, 2)}px`);
    bar.scrollLeft = 120;
    fireEvent.scroll(bar);
    const list = screen.getByRole("treegrid", { name: "Tasks" });
    expect(list.style.getPropertyValue("--list-x")).toBe("120px");
    expect(list.style.getPropertyValue("--list-over")).toBe(`${listContentWidth(false, 2) - 300 + 1}px`); // and the list's right border
    expect(screen.getByRole("button", { name: "Delete “t”" }).closest("[data-row-actions]")).toHaveAttribute("data-pinned");
  });

  it("narrower, the # column stays at the list's left edge, covering what scrolls past it", async () => {
    useBoardView.getState().setListWidth(300);
    await board([task("t", { userStart: "2026-10-12" })]);
    const number = () => screen.getByRole("gridcell", { name: "Row 1" });
    expect(number()).toHaveAttribute("data-pinned");
    expect(number().style.transform).toBe("translateX(var(--list-x, 0px))");
    // The row's 4 px of padding is covered too.
    expect(number().style.marginLeft).toBe("-4px");
    expect(number().style.paddingLeft).toBe("4px");
    expect(document.querySelector("[data-list-header] [data-pinned]")).not.toBeNull();
  });

  it("pinned cells keep the line between rows, which their background would otherwise hide", async () => {
    useBoardView.getState().setListWidth(300);
    await board([task("t", { userStart: "2026-10-12" })]);
    const line = "linear-gradient(to top, var(--grid) 1px, transparent 1px)";
    expect(screen.getByRole("gridcell", { name: "Row 1" }).style.background).toContain(line);
    expect((screen.getByRole("button", { name: "Delete “t”" }).closest("[data-row-actions]") as HTMLElement).style.background).toContain(line);
  });

  it("pinned cells line up with the rows: the action buttons fit inside a row (24 px), so the cells aren't taller", async () => {
    await board([task("t", { userStart: "2026-10-12" })]);
    for (const name of ["Show “t” on the chart", "Delete “t”"]) expect(screen.getByRole("button", { name })).toHaveClass("h-6!");
  });

  it("pinned cells take the row's hover colour, through a variable the row sets on hover", async () => {
    useBoardView.getState().setListWidth(300);
    await board([task("t", { userStart: "2026-10-12" })]);
    const number = screen.getByRole("gridcell", { name: "Row 1" });
    expect(number.closest('[role="row"]')).toHaveClass("hover:bg-surface-2", "hover:[--row-bg:var(--surface-2)]");
    expect(number.style.background).toContain("var(--row-bg, var(--surface))");
    const actions = screen.getByRole("button", { name: "Delete “t”" }).closest("[data-row-actions]") as HTMLElement;
    expect(actions.style.background).toContain("var(--row-bg, var(--surface))");
  });

  it("pinned headings keep the header's bottom border, which their background would otherwise cover", async () => {
    useBoardView.getState().setListWidth(300);
    await board([task("t", { userStart: "2026-10-12" })]);
    const pinned = document.querySelectorAll("[data-list-header] [data-pinned]");
    expect(pinned).toHaveLength(2); // # and the row actions
    // As a 1 px line in the background, so the heading stays the header row's height.
    for (const cell of pinned) expect((cell as HTMLElement).style.background).toContain("linear-gradient(to top, var(--border) 1px, transparent 1px)");
  });

  it("pinned, the actions reach the list's right edge, so nothing shows past them", async () => {
    useBoardView.getState().setListWidth(300);
    await board([task("t", { userStart: "2026-10-12" })]);
    const cell = screen.getByRole("button", { name: "Delete “t”" }).closest("[data-row-actions]") as HTMLElement;
    // Past the cell: the row's 4 px of padding and the list's 1 px border.
    expect(cell.style.marginRight).toBe("-5px");
    expect(cell.style.paddingRight).toBe("5px");
  });

  it("a row with nothing inside has its two actions side by side, with no gap where the third would be", async () => {
    await board([task("t", { userStart: "2026-10-12" })]);
    const actions = screen.getByRole("button", { name: "Delete “t”" }).parentElement!;
    expect([...actions.children].map((child) => child.getAttribute("aria-label"))).toEqual(["Show “t” on the chart", "Delete “t”"]);
  });

  it("can't be scrolled by the browser bringing a cell into view: only its own scrollbar moves it", async () => {
    useBoardView.getState().setListWidth(300);
    await board([task("t", { userStart: "2026-10-12" })]);
    // clip, not hidden: a hidden overflow can still be scrolled, which would throw the rows and the pinned actions out of line
    expect(screen.getByRole("treegrid", { name: "Tasks" })).toHaveClass("overflow-clip");
    expect(document.querySelector("[data-list-header]")).toHaveClass("overflow-clip");
  });
});

describe("the chart beside the list", () => {
  it("isn't clipped as it scrolls (a clip would lag the native scroll by a frame), but tells its bars how far it has gone", async () => {
    await board([task("t", { userStart: "2026-10-12" })]);
    const scroller = screen.getByTestId("board-scroller");
    expect((document.querySelector("[data-chart-body]") as HTMLElement).style.clipPath).toBe("");
    expect((document.querySelector("[data-chart-header]") as HTMLElement).style.clipPath).toBe("");
    scroller.scrollLeft = 300;
    fireEvent.scroll(scroller);
    expect((scroller.firstElementChild as HTMLElement).style.getPropertyValue("--chart-hidden")).toBe("300px");
  });
});

describe("the details drawer", () => {
  it("collapses to a strip wide enough to read and hit (36 px), and opens to its usual width", async () => {
    await board([task("t", { userStart: "2026-10-12" })]);
    expect(await screen.findByRole("button", { name: "Show details" })).toHaveClass("w-9");
    act(() => useSelection.getState().openPanel());
    expect((await screen.findByRole("complementary", { name: "Details" })).className).toContain("w-[min(26rem,92%)]");
  });

  it("collapsed, its strip doesn't cover the filter bar's end: the bar leaves room for it (36 px + 8)", async () => {
    await board([task("t", { userStart: "2026-10-12" })]);
    expect(await screen.findByRole("button", { name: "Show details" })).toHaveClass("w-9");
    expect(screen.getByRole("toolbar", { name: "Filters" })).toHaveClass("pr-11");
  });

  it("slides open, even with nothing selected (still, for reduced motion)", async () => {
    await board([task("t", { userStart: "2026-10-12" })]);
    act(() => useSelection.getState().openPanel());
    const drawer = await screen.findByRole("complementary", { name: "Details" });
    expect(drawer).toHaveClass("animate-panel-in", "motion-reduce:animate-none");
  });

  it("is one drawer: picking a task while it's open only changes what's inside, without opening again", async () => {
    await board([task("t", { userStart: "2026-10-12" }), task("u", { userStart: "2026-10-12" })]);
    act(() => useSelection.getState().openPanel());
    const drawer = await screen.findByRole("complementary", { name: "Details" });
    fireEvent.animationEnd(drawer); // slid in
    act(() => useSelection.getState().select("t", false));
    expect(screen.getByRole("complementary", { name: "Details of “t”" })).toBe(drawer);
    act(() => useSelection.getState().select("u", false));
    expect(screen.getByRole("complementary", { name: "Details of “u”" })).toBe(drawer);
    // And back to nothing selected: still the same drawer, open.
    act(() => useSelection.getState().select(null, false));
    expect(screen.getByRole("complementary", { name: "Details" })).toBe(drawer);
    expect(drawer).toHaveClass("animate-panel-in");
    expect(drawer).toHaveTextContent("Select a task to see its details");
  });

  it("collapsed on a task, it slides out still showing that task", async () => {
    await board([task("t", { userStart: "2026-10-12" })]);
    act(() => useSelection.getState().select("t"));
    const drawer = await screen.findByRole("complementary", { name: "Details of “t”" });
    act(() => useSelection.getState().closePanel());
    expect(drawer).toHaveClass("animate-panel-out");
    expect(drawer).toHaveAttribute("aria-label", "Details of “t”");
    fireEvent.animationEnd(drawer);
    expect(drawer).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show details of “t”" })).toBeInTheDocument();
  });

  it("with nothing selected, it slides away when collapsed, rather than vanishing", async () => {
    await board([task("t", { userStart: "2026-10-12" })]);
    act(() => useSelection.getState().openPanel());
    const drawer = await screen.findByRole("complementary", { name: "Details" });
    act(() => useSelection.getState().closePanel());
    // Still there while it slides out, but hidden from everyone and out of the tab order; gone once it's out.
    expect(drawer).toBeInTheDocument();
    expect(drawer).toHaveClass("animate-panel-out");
    expect(drawer).toHaveAttribute("aria-hidden", "true");
    expect(drawer).toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "Show details" })).toBeInTheDocument();
    fireEvent.animationEnd(drawer);
    expect(drawer).not.toBeInTheDocument();
  });
});

describe("the chart's own scrollbar", () => {
  it("sits beside the list's, not under it, and moves the chart (and follows it)", async () => {
    useBoardView.getState().setListWidth(300);
    await board([task("t", { userStart: "2026-10-12" })]);
    const scroller = screen.getByTestId("board-scroller");
    // The board's own sideways scrollbar would run under the list: it sits past the bottom, out of view.
    expect(scroller.style.bottom).toBe("-20px");
    expect(scroller.parentElement).toHaveClass("overflow-hidden");
    const bar = screen.getByTestId("chart-scrollbar");
    const chart = document.querySelector("[data-chart-body]") as HTMLElement;
    expect((bar.firstElementChild as HTMLElement).style.width).toBe(chart.style.width);
    expect(bar.parentElement!.style.marginLeft).toBe(`${useBoardView.getState().listWidth}px`);
    bar.scrollLeft = 200;
    fireEvent.scroll(bar);
    expect(scroller.scrollLeft).toBe(200);
    scroller.scrollLeft = 350;
    fireEvent.scroll(scroller);
    expect(bar.scrollLeft).toBe(350);
  });
});
