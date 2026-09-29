import type { Command } from "@ganttlines/engine";
import type { ProjectStateDto } from "@ganttlines/protocol";
import { waitFor, within } from "@testing-library/react";
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

  it("edits working days and predecessors from their columns", async () => {
    const { user } = await editableBoard();
    await user.click(screen.getByRole("button", { name: "Working days of “hooks”" }));
    await user.keyboard("{Control>}a{/Control}0{Enter}");
    expect(sentCommands().at(-1)).toEqual({ type: "convertMilestone", id: "hooks", milestone: true });
    await user.click(screen.getByRole("button", { name: "Predecessor of “hooks”" }));
    await user.keyboard("#2 +1{Enter}");
    expect(sentCommands().slice(-2)).toEqual([
      { type: "linkTasks", fromId: "ui", toId: "hooks" },
      { type: "setOffset", id: "hooks", offset: 1 },
    ]);
    expect(within(listRow("hooks")).getByText("#2 +1")).toBeInTheDocument();
  });

  it("explains edits the engine refuses and doesn't send them", async () => {
    const { user } = await editableBoard();
    await user.click(screen.getByRole("button", { name: "Predecessor of “hooks”" }));
    await user.keyboard("#1{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Row #1 is a section");
    expect(sentCommands()).toEqual([]);
  });

  it("shows the server's reason when it refuses an edit, and rolls it back", async () => {
    const { user } = await editableBoard();
    await user.click(screen.getByRole("button", { name: "Color of “ui”: blue" }));
    await user.click(screen.getByRole("button", { name: "green" }));
    expect(screen.getByRole("button", { name: "Color of “ui”: green" })).toBeInTheDocument();
    const { commandId } = FakeWebSocket.last.sent.at(-1) as { commandId: string };
    FakeWebSocket.last.deliver({ type: "reject", commandId, error: "conflict", message: "This project is archived" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Change not saved: This project is archived");
    expect(screen.getByRole("button", { name: "Color of “ui”: blue" })).toBeInTheDocument();
  });

  it("filters rows by search, keeping their parents", async () => {
    const { user } = await editableBoard();
    await user.type(screen.getByRole("searchbox", { name: "Search tasks" }), "hoo");
    expect(screen.getAllByRole("row").map((row) => row.getAttribute("aria-level"))).toEqual(["1", "2"]);
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
    for (let i = 0; i < 6; i++) {
      await user.tab();
      stops.push(document.activeElement?.getAttribute("aria-label") ?? "");
    }
    expect(stops).toEqual([
      "Add a subtask to “ui”",
      "Assignee of “ui”: nobody",
      "Working days of “ui”",
      "Calendar days of “ui”",
      "Predecessor of “ui”",
      "Color of “ui”: blue",
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

  it("sets calendar days by moving the end date", async () => {
    const { user } = await editableBoard();
    await user.click(within(listRow("ui")).getByText("2")); // a selected row: Enter on the list would edit its title
    screen.getByRole("button", { name: "Calendar days of “ui”" }).focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{Control>}a{/Control}3{Enter}");
    // ui starts Wed 2026-09-30: 3 calendar days end on Fri 2026-10-02
    expect(sentCommands()).toEqual([{ type: "resizeTask", id: "ui", edge: "end", date: "2026-10-02" }]);
    expect(within(listRow("ui")).getByRole("button", { name: "Working days of “ui”" })).toHaveTextContent("3");
    expect(screen.queryByRole("textbox", { name: "Title" })).not.toBeInTheDocument(); // Enter on the cell didn't also edit the title
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
});
