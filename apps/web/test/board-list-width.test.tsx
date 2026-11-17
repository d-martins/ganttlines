import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LIST_WIDTH, listContentWidth, useBoardView } from "../src/board/view-store";
import { task } from "./board-fixtures";
import { board } from "./chart-board";
import { screen } from "./utils";

describe("the task list's width", () => {
  it("keeps every column: the content is as wide as the columns need, the task name at least 200 px", () => {
    expect(listContentWidth(false)).toBe(40 + 200 + 120 + 40 + 40 + 76 + 8);
    expect(listContentWidth(true)).toBe(listContentWidth(false) + 72);
  });

  it("can be made narrower than the columns, and starts wide enough for them", () => {
    expect(LIST_WIDTH.min).toBeLessThan(listContentWidth(false));
    expect(LIST_WIDTH.initial).toBeGreaterThanOrEqual(listContentWidth(false));
    useBoardView.getState().setListWidth(10);
    expect(useBoardView.getState().listWidth).toBe(LIST_WIDTH.min);
  });

  it("wide enough: no scrollbar", async () => {
    await board([task("t", { userStart: "2026-10-12" })]);
    expect(screen.queryByTestId("list-scrollbar")).not.toBeInTheDocument();
  });

  it("narrower: a scrollbar under the list moves the columns, and the actions stay put", async () => {
    useBoardView.getState().setListWidth(300);
    await board([task("t", { userStart: "2026-10-12" })]);
    const bar = screen.getByTestId("list-scrollbar");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe(`${listContentWidth(false)}px`);
    bar.scrollLeft = 120;
    fireEvent.scroll(bar);
    const list = screen.getByRole("treegrid", { name: "Tasks" });
    expect(list.style.getPropertyValue("--list-x")).toBe("120px");
    expect(list.style.getPropertyValue("--list-over")).toBe(`${listContentWidth(false) - 300 + 1}px`); // and the list's right border
    expect(screen.getByRole("button", { name: "Delete “t”" }).closest("[data-row-actions]")).toHaveAttribute("data-pinned");
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
