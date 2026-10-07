import type { Command } from "@ganttlines/engine";
import type { ProjectStateDto } from "@ganttlines/protocol";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANA, CALENDAR, FakeWebSocket, PROJECT_ID, projectState, section, task } from "./board-fixtures";
import { ADMIN, project, renderApp, screen, signedIn, VIEWER } from "./utils";

const ROWS = [
  section("design", { position: "a0" }),
  task("ui", { parentId: "design", position: "a0", userStart: "2026-09-30", duration: 5 }),
  task("hooks", { parentId: "design", position: "a1", userStart: "2026-10-12", duration: 2 }),
];

async function editableBoard(rows: ProjectStateDto["rows"] = ROWS, user = ADMIN) {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const api = signedIn(user, [project(PROJECT_ID, "Launch")]);
  api.on(`GET /api/projects/${PROJECT_ID}/state`, () => ({ body: projectState(rows) }));
  api.on("GET /api/calendar", () => ({ body: CALENDAR }));
  api.on("GET /api/resources", () => ({ body: { resources: [ANA] } }));
  api.on(`GET /api/projects/${PROJECT_ID}/highlights`, () => ({ body: { highlights: [] } }));
  api.on(`GET /api/projects/${PROJECT_ID}/baselines`, () => ({ body: { baselines: [] } }));
  const app = renderApp(`/p/${PROJECT_ID}`);
  await screen.findByRole("treegrid", { name: "Tasks" });
  await waitFor(() => expect(FakeWebSocket.last.sent).toHaveLength(1));
  FakeWebSocket.last.deliver({ type: "joined", projectId: PROJECT_ID, version: 5, instanceVersion: 1, viewers: [] });
  return { api, ...app };
}

/** Commands the board sent, without their ids. */
const sentCommands = (): Command[] =>
  FakeWebSocket.last.sent.flatMap((message) => ((message as { type: string }).type === "command" ? [(message as { command: Command }).command] : []));
const listRow = (title: string) => screen.getAllByRole("row").find((row) => within(row).queryByText(title, { exact: true }))!;

describe("editing the task list", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 29, 12));
  });
  afterEach(() => vi.useRealTimers());

  it("scrolls the list while a row is dragged near its bottom edge", async () => {
    await editableBoard();
    const scroller = screen.getByTestId("board-scroller");
    scroller.getBoundingClientRect = () => ({ top: 0, bottom: 400, left: 0, right: 1200, width: 1200, height: 400, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Move “ui”" }), { button: 0, clientY: 60 });
    fireEvent.pointerMove(window, { clientY: 395 });
    await waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(0));
    fireEvent.pointerUp(window, { clientY: 395 });
  });

  it("renames on Enter and starts the next row", async () => {
    const { user } = await editableBoard();
    await user.dblClick(within(listRow("ui")).getByText("ui"));
    const input = screen.getByRole("textbox", { name: "Title" });
    await user.clear(input);
    await user.type(input, "Intelligent UI{Enter}");
    expect(sentCommands()[0]).toEqual({ type: "updateTitle", id: "ui", title: "Intelligent UI" });
    expect(sentCommands()[1]).toMatchObject({ type: "createRow", kind: "task", parentId: "design", afterId: "ui", title: "" });
    const next = screen.getByRole("textbox", { name: "Title" });
    await user.type(next, "Press kit{Enter}");
    const created = (sentCommands()[1] as Extract<Command, { type: "createRow" }>).id;
    expect(sentCommands()[2]).toEqual({ type: "updateTitle", id: created, title: "Press kit" });
  });

  it("adds a new team member from the picker and assigns them", async () => {
    const { api, user } = await editableBoard();
    api.on("POST /api/resources", () => ({ status: 201, body: { resource: { ...ANA, id: "r-zed", name: "Zed" } } }));
    await user.click(screen.getByRole("button", { name: "Assignee of “ui”: nobody" }));
    await user.type(await screen.findByRole("combobox", { name: "Find a person" }), "Zed");
    await user.click(await screen.findByRole("option", { name: /New team member “Zed”/ }));
    await waitFor(() => expect(sentCommands()).toEqual([{ type: "setAssignee", id: "ui", resourceId: "r-zed" }]));
  });

  it("assigns people from the picker", async () => {
    const { user } = await editableBoard();
    await user.click(screen.getByRole("button", { name: "Assignee of “ui”: nobody" }));
    const search = await screen.findByRole("combobox", { name: "Find a person" });
    await user.type(search, "ana{Enter}");
    expect(sentCommands()).toEqual([{ type: "setAssignee", id: "ui", resourceId: ANA.id }]);
  });

  it("indents with Alt+Shift+→ while typing; Tab just moves on, keeping the title", async () => {
    const { user } = await editableBoard();
    await user.dblClick(within(listRow("hooks")).getByText("hooks"));
    await user.keyboard("{Alt>}{Shift>}{ArrowRight}{/Shift}{/Alt}");
    expect(sentCommands()).toEqual([{ type: "indent", id: "hooks" }]);
    const input = screen.getByRole("textbox", { name: "Title" });
    expect(input.closest('[role="row"]')).toHaveAttribute("aria-level", "3");
    await user.type(input, " v2");
    await user.tab();
    expect(sentCommands()).toEqual([
      { type: "indent", id: "hooks" },
      { type: "updateTitle", id: "hooks", title: "hooks v2" },
    ]);
    expect(input).not.toBeInTheDocument();
  });

  it("indents the selected row from the keyboard or the header, never with Tab", async () => {
    const { user } = await editableBoard();
    await user.click(within(listRow("hooks")).getByText("3"));
    await user.keyboard("{Tab}");
    expect(sentCommands()).toEqual([]);
    await user.click(within(listRow("hooks")).getByText("3"));
    await user.keyboard("{Alt>}{Shift>}{ArrowLeft}{/Shift}{/Alt}");
    expect(sentCommands()).toEqual([{ type: "outdent", id: "hooks" }]);
    await user.click(screen.getByRole("button", { name: /^Indent/ }));
    expect(sentCommands().at(-1)).toEqual({ type: "indent", id: "hooks" });
  });

  it("collapses rows in this browser only, for viewers too", async () => {
    const { user } = await editableBoard(ROWS, VIEWER);
    const list = within(screen.getByRole("treegrid", { name: "Tasks" }));
    await user.click(within(listRow("design")).getByRole("button", { name: "Collapse" }));
    expect(list.queryByText("ui", { exact: true })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(`gp.collapsed:${PROJECT_ID}`)!)).toEqual(["design"]);
    expect(sentCommands()).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Expand all" }));
    expect(list.getByText("ui", { exact: true })).toBeInTheDocument();
  });

  it("drops an untitled new row on Escape", async () => {
    const { user } = await editableBoard();
    await user.click(screen.getByRole("button", { name: "Add task" }));
    const created = (sentCommands().at(-1) as Extract<Command, { type: "createRow" }>).id;
    expect(sentCommands().at(-1)).toMatchObject({ type: "createRow", parentId: null, afterId: "design", kind: "task" });
    await user.keyboard("{Escape}");
    expect(sentCommands().at(-1)).toEqual({ type: "deleteRows", ids: [created] });
    expect(screen.queryByRole("textbox", { name: "Title" })).not.toBeInTheDocument();
  });

  it("selects with the arrow keys, deletes with Delete and offers Undo", async () => {
    const { user } = await editableBoard();
    await user.click(within(listRow("ui")).getByText("2"));
    await user.keyboard("{ArrowDown}");
    expect(listRow("hooks")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Delete}");
    expect(sentCommands()).toEqual([{ type: "deleteRows", ids: ["hooks"] }]);
    expect(screen.queryByText("hooks", { exact: true })).not.toBeInTheDocument(); // shown at once, before the server answers
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    expect(FakeWebSocket.last.sent.at(-1)).toMatchObject({ type: "undo" });
  });

  it("deletes a row from its own Delete button; a section says how much went with it", async () => {
    const { user } = await editableBoard();
    await user.click(screen.getByRole("button", { name: "Delete “hooks”" }));
    expect(sentCommands()).toEqual([{ type: "deleteRows", ids: ["hooks"] }]);
    expect(await screen.findByText("Deleted “hooks”")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete “design”" }));
    expect(sentCommands().at(-1)).toEqual({ type: "deleteRows", ids: ["design"] });
    expect(await screen.findByText("Deleted “design” and 1 row inside")).toBeInTheDocument();
    expect(screen.queryByText("ui", { exact: true })).not.toBeInTheDocument();
  });

  it("deletes the row shown in the details panel, and closes the panel", async () => {
    const { user } = await editableBoard();
    await user.click(screen.getByRole("button", { name: "Open details of “ui”" }));
    const panel = await screen.findByRole("complementary", { name: "Details of “ui”" });
    await user.click(within(panel).getByRole("button", { name: "Delete task" }));
    expect(sentCommands()).toEqual([{ type: "deleteRows", ids: ["ui"] }]);
    await waitFor(() => expect(screen.queryByRole("complementary")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Open details of “design”" }));
    expect(within(await screen.findByRole("complementary", { name: "Details of “design”" })).getByRole("button", { name: "Delete section" })).toBeInTheDocument();
  });

  it("offers no delete buttons to viewers", async () => {
    const { user } = await editableBoard(ROWS, VIEWER);
    expect(screen.queryByRole("button", { name: /^Delete “/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open details of “ui”" }));
    expect(within(await screen.findByRole("complementary", { name: "Details of “ui”" })).queryByRole("button", { name: /^Delete / })).not.toBeInTheDocument();
  });

  it("edits working days and predecessors from their columns", async () => {
    const { user } = await editableBoard();
    await user.click(screen.getByRole("button", { name: "Working days of “hooks”" }));
    await user.keyboard("{Control>}a{/Control}0{Enter}");
    expect(sentCommands().at(-1)).toEqual({ type: "convertMilestone", id: "hooks", milestone: true });
    // The predecessor opens a searchable list of tasks (row number or title), like the assignee picker.
    await user.click(screen.getByRole("button", { name: "Predecessor of “hooks”" }));
    const search = screen.getByRole("combobox", { name: "Find a predecessor" });
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("No predecessor");
    expect(screen.queryByRole("option", { name: /design/ })).not.toBeInTheDocument(); // sections can't be predecessors
    await user.type(search, "#2{Enter}");
    expect(sentCommands().at(-1)).toEqual({ type: "linkTasks", fromId: "ui", toId: "hooks" });
    expect(within(listRow("hooks")).getByText("#2")).toBeInTheDocument();
    await user.keyboard(" "); // Space on the focused cell opens it again: the choice is checked, no offset to edit
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("#2 ui");
    expect(screen.queryByRole("spinbutton", { name: /offset/i })).not.toBeInTheDocument();
  });

  it("explains edits the engine refuses and doesn't send them", async () => {
    const { user } = await editableBoard([...ROWS, task("idea", { parentId: "design", position: "a2" })]);
    await user.click(screen.getByRole("button", { name: "Predecessor of “hooks”" }));
    await user.type(screen.getByRole("combobox", { name: "Find a predecessor" }), "idea{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Both tasks need dates before they can be linked");
    expect(sentCommands()).toEqual([]);
  });

  it("shows the server's reason when it refuses an edit, and rolls it back", async () => {
    const { user } = await editableBoard();
    await user.click(screen.getByRole("button", { name: "Working days of “ui”" }));
    await user.keyboard("{Control>}a{/Control}8{Enter}");
    expect(screen.getByRole("button", { name: "Working days of “ui”" })).toHaveTextContent("8");
    const { commandId } = FakeWebSocket.last.sent.at(-1) as { commandId: string };
    FakeWebSocket.last.deliver({ type: "reject", commandId, error: "conflict", message: "This project is archived" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Change not saved: This project is archived");
    expect(screen.getByRole("button", { name: "Working days of “ui”" })).toHaveTextContent("5");
  });

  it("filters rows by search, keeping their parents", async () => {
    const { user } = await editableBoard();
    await user.type(screen.getByRole("searchbox", { name: "Search tasks" }), "hoo");
    expect(screen.getAllByRole("row").slice(1).map((row) => row.getAttribute("aria-level"))).toEqual(["1", "2"]); // (after the header row)
    expect(screen.queryByText("ui", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add task" })).not.toBeInTheDocument();
  });

  it("is read-only for viewers", async () => {
    const { user } = await editableBoard(ROWS, VIEWER);
    await user.dblClick(within(listRow("ui")).getByText("ui"));
    expect(screen.queryByRole("textbox", { name: "Title" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add task" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Undo/ })).toBeDisabled();
  });

  it("reaches every editable cell with Tab and opens it with Space", async () => {
    const { user } = await editableBoard();
    screen.getByRole("button", { name: "Title “ui”" }).focus();
    const stops: string[] = [];
    for (let i = 0; i < 7; i++) {
      await user.tab();
      stops.push(document.activeElement?.getAttribute("aria-label") ?? "");
    }
    expect(stops).toEqual([
      "Add a subtask to “ui”",
      "Assignee of “ui”: nobody",
      "Working days of “ui”",
      "Actual work days of “ui”",
      "Predecessor of “ui”",
      "Show “ui” on the chart",
      "Open details of “ui”",
    ]);
    screen.getByRole("button", { name: "Title “ui”" }).focus();
    await user.keyboard(" ");
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("ui");
    await user.keyboard("{Escape}");
    // Back on the same cell, ready to go on with the keyboard.
    await waitFor(() => expect(screen.getByRole("button", { name: "Title “ui”" })).toHaveFocus());
    screen.getByRole("button", { name: "Working days of “ui”" }).focus();
    await user.keyboard(" ");
    expect(screen.getByRole("textbox", { name: "Working days" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Working days of “ui”" })).toHaveFocus());
    expect(sentCommands()).toEqual([]);
  });

  it("records actual work days from their column (Enter on the cell doesn't edit the title)", async () => {
    const { user } = await editableBoard();
    await user.click(within(listRow("ui")).getByText("2")); // a selected row: Enter on the list would edit its title
    screen.getByRole("button", { name: "Actual work days of “ui”" }).focus();
    await user.keyboard("{Enter}");
    await user.keyboard("7,5{Enter}");
    expect(sentCommands()).toEqual([{ type: "setActualDuration", id: "ui", days: 7.5 }]);
    expect(within(listRow("ui")).getByRole("gridcell", { name: "7.5 actual work days" })).toHaveClass("text-[var(--awd-over)]");
    expect(screen.queryByRole("textbox", { name: "Title" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Actual work days of “ui”" }));
    await user.keyboard("{Control>}a{/Control}{Backspace}{Enter}"); // empty clears it
    expect(sentCommands().at(-1)).toEqual({ type: "setActualDuration", id: "ui", days: null });
  });

  it("opens the assignee picker on the current assignee", async () => {
    const { user } = await editableBoard(ROWS.map((row) => (row.id === "ui" ? { ...row, resourceId: ANA.id } : row)));
    await user.click(screen.getByRole("button", { name: "Assignee of “ui”: Ana Silva" }));
    const search = await screen.findByRole("combobox", { name: "Find a person" });
    expect(document.getElementById(search.getAttribute("aria-activedescendant")!)).toHaveTextContent("Ana Silva");
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("Ana Silva");
    await user.keyboard("{Enter}");
    expect(sentCommands()).toEqual([]); // Enter on the current person changes nothing
  });

  it("clicking empty space under the rows clears the selection without focusing the list", async () => {
    const { user } = await editableBoard();
    await user.click(within(listRow("ui")).getByText("2"));
    expect(listRow("ui")).toHaveAttribute("aria-selected", "true");
    const list = screen.getByRole("treegrid", { name: "Tasks" });
    await user.pointer({ keys: "[MouseLeft]", target: list });
    expect(listRow("ui")).toHaveAttribute("aria-selected", "false");
    expect(list).not.toHaveFocus();
    expect(list).not.toHaveAttribute("tabindex", "0");
  });

  it("opens every cell on a single click, selecting the row too", async () => {
    const { user } = await editableBoard();
    await user.click(screen.getByRole("button", { name: "Working days of “ui”" }));
    expect(screen.getByRole("textbox", { name: "Working days" })).toHaveFocus();
    expect(listRow("ui")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Title “hooks”" }));
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("hooks");
  });
});
