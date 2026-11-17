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
    expect(screen.getByRole("button", { name: "Open details of “t”" }).closest("[data-row-actions]")).toHaveAttribute("data-pinned");
  });
});
