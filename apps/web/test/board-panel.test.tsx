import { toDay, type Command, type Link, type TaskRow } from "@ganttlines/engine";
import type { CommentDto, ProjectStateDto } from "@ganttlines/protocol";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeEntry } from "../src/board/panel/activity";
import { RichTextView } from "../src/ui/rich-text";
import { ANA, CALENDAR, FakeWebSocket, PROJECT_ID, projectState, section, task } from "./board-fixtures";
import { ADMIN, project, renderApp, screen, signedIn, VIEWER } from "./utils";
import { placeSuggestions } from "../src/board/panel/suggestion-list";
import { newMilestonePlace } from "../src/board/slack";
import { isCriticalPathOn, useCriticalPathView } from "../src/board/critical-path-view";
import { formatDay } from "../src/board/format";

const ROWS = [
  section("x", { position: "a0" }),
  task("ui", { parentId: "x", position: "a0", userStart: "2026-09-30", duration: 5 }),
  task("hooks", { parentId: "x", position: "a1", userStart: "2026-10-12", duration: 2, resourceId: ANA.id }),
];

const LINK_ROWS = [...ROWS, task("qa", { parentId: "x", position: "a2", userStart: "2026-10-20", duration: 1 })];
const LINKS: ProjectStateDto["links"] = [
  { predecessorId: "ui", followerId: "hooks", kind: "FS", lag: 2 },
  { predecessorId: "hooks", followerId: "qa", kind: "SS", lag: 0 },
];

const comment = (id: string, fields: Partial<CommentDto> = {}): CommentDto => ({
  id,
  taskId: "hooks",
  author: { userId: "u-other", label: "Rui" },
  body: `comment ${id}`,
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  editedAt: null,
  deleted: false,
  mine: false,
  ...fields,
});

async function panelBoard(rows: ProjectStateDto["rows"] = ROWS, user = ADMIN, comments: CommentDto[] = [], links: ProjectStateDto["links"] = [], search = "") {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const api = signedIn(user, [project(PROJECT_ID, "Launch")]);
  api.on(`GET /api/projects/${PROJECT_ID}/state`, () => ({ body: projectState(rows, 5, links) }));
  api.on("GET /api/calendar", () => ({ body: CALENDAR }));
  api.on("GET /api/resources", () => ({ body: { resources: [ANA] } }));
  api.on(`GET /api/projects/${PROJECT_ID}/highlights`, () => ({ body: { highlights: [] } }));
  api.on(`GET /api/projects/${PROJECT_ID}/baselines`, () => ({ body: { baselines: [] } }));
  api.on(`GET /api/projects/${PROJECT_ID}/comments`, () => ({ body: { comments, nextBefore: null } }));
  api.on(`GET /api/projects/${PROJECT_ID}/activity`, () => ({
    body: {
      entries: [
        {
          version: 4,
          commandId: "c4",
          name: "setAssignee",
          actor: { userId: null, label: "Sam (anonymous)", linkId: "l1" },
          createdAt: new Date().toISOString(),
          rowIds: ["hooks"],
          changes: [{ rowId: "hooks", field: "resourceId", before: null, after: ANA.id }],
        },
      ],
      nextBefore: null,
    },
  }));
  const app = renderApp(`/p/${PROJECT_ID}${search}`);
  await screen.findByRole("treegrid", { name: "Tasks" });
  await waitFor(() => expect(FakeWebSocket.last.sent).toHaveLength(1));
  FakeWebSocket.last.deliver({ type: "joined", projectId: PROJECT_ID, version: 5, instanceVersion: 1, viewers: [] });
  return { api, ...app };
}

const sentCommands = (): Command[] =>
  FakeWebSocket.last.sent.flatMap((message) => ((message as { type: string }).type === "command" ? [(message as { command: Command }).command] : []));
const panel = () => screen.getByRole("complementary", { name: /^Details of/ });
const rowOf = (title: string) => screen.getAllByRole("row").find((candidate) => within(candidate).queryByText(title, { exact: true }))!;
/** Opens a row: a double-click on its number in the list (selects it, reveals its bar and opens the panel). */
const selectRow = async (user: ReturnType<typeof import("@testing-library/user-event").default.setup>, title: string) => {
  await user.dblClick(rowOf(title).querySelector('[aria-label^="Row "]')!);
  await screen.findByRole("complementary", { name: /^Details of/ }); // (the panel is a separate download)
};

describe("details panel", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 29, 12));
  });
  afterEach(() => vi.useRealTimers());

  it("opens when a row is selected, edits fields, closes with Escape and gives focus back to the row", async () => {
    const { user } = await panelBoard();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    await selectRow(user, "hooks");
    expect(panel()).toHaveAccessibleName("Details of “hooks”");
    expect(panel()).not.toHaveFocus(); // the list keeps the keyboard
    const title = within(panel()).getByRole("textbox", { name: "Task title" });
    await user.clear(title);
    await user.type(title, "Hooks v2{Enter}");
    expect(sentCommands().at(-1)).toEqual({ type: "updateTitle", id: "hooks", title: "Hooks v2" });
    const days = within(panel()).getByRole("spinbutton", { name: "Working days" });
    await user.clear(days);
    await user.type(days, "4{Enter}");
    expect(sentCommands().at(-1)).toEqual({ type: "setDuration", id: "hooks", duration: 4 });
    await user.click(within(panel()).getByRole("button", { name: "Add link" }));
    await user.type(screen.getByRole("combobox", { name: "Find a task to link" }), "ui{Enter}");
    expect(sentCommands().at(-1)).toEqual({ type: "addLink", predecessorId: "ui", followerId: "hooks", kind: "FS" });
    await user.type(within(panel()).getByRole("textbox", { name: "Description" }), "Billing events");
    await user.click(title); // leaving the description saves it
    expect(sentCommands().at(-1)).toEqual({ type: "setDescription", id: "hooks", description: "Billing events" });
    within(panel()).getByRole("button", { name: "Close details (Esc)" }).focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument(); // closed: hidden and inert while it slides out
    expect(screen.getByRole("button", { name: "Title “Hooks v2”" })).toHaveFocus();
    await selectRow(user, "ui");
    expect(panel()).toHaveAccessibleName("Details of “ui”"); // selecting again reopens it
  });

  it("puts the description first and edits it as formatted text, saved as Markdown", async () => {
    const { user } = await panelBoard();
    await selectRow(user, "hooks");
    const description = within(panel()).getByRole("textbox", { name: "Description" });
    const assignee = within(panel()).getByRole("button", { name: /^Assignee/ });
    // right under the title, before the fields
    expect(description.compareDocumentPosition(assignee) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const box = description.closest(".overflow-y-auto") as HTMLElement;
    expect(box.style.height).toBe("72px"); // empty: its minimum
    expect(within(panel()).getByRole("toolbar", { name: "Description formatting" })).toHaveClass("max-h-0");
    await user.click(description);
    // focused: opens to half the panel (jsdom has no layout, so the panel's fallback half-height)
    expect(box.style.height).toBe("240px");
    expect(box).toHaveClass("transition-[height]");
    expect(within(panel()).getByRole("toolbar", { name: "Description formatting" })).toHaveClass("max-h-10");
    await user.click(within(within(panel()).getByRole("toolbar", { name: "Description formatting" })).getByRole("button", { name: "Bold (⌘B)" }));
    await user.type(description, "Billing");
    await user.click(within(panel()).getByRole("textbox", { name: "Task title" })); // leaving saves it
    expect(sentCommands().at(-1)).toEqual({ type: "setDescription", id: "hooks", description: "**Billing**" });
    expect(box.style.height).toBe("72px");
  });

  it("follows the selection without taking focus from the list", async () => {
    const { user } = await panelBoard();
    await selectRow(user, "ui");
    expect(panel()).toHaveAccessibleName("Details of “ui”");
    screen.getByRole("treegrid", { name: "Tasks" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(panel()).toHaveAccessibleName("Details of “hooks”");
    expect(screen.getByRole("treegrid", { name: "Tasks" })).toHaveFocus();
  });

  it("opens from the list only: a click on the chart selects, and retargets the panel only if it's open", async () => {
    const { user } = await panelBoard();
    const hooksBar = screen.getByRole("button", { name: /^hooks,/ });
    fireEvent.pointerDown(hooksBar, { button: 0, clientX: 10, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 10, clientY: 0 });
    expect(screen.getAllByRole("row").find((row) => row.getAttribute("aria-selected") === "true")).toHaveTextContent("hooks");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    await selectRow(user, "ui");
    expect(panel()).toHaveAccessibleName("Details of “ui”");
    fireEvent.pointerDown(hooksBar, { button: 0, clientX: 10, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 10, clientY: 0 });
    expect(panel()).toHaveAccessibleName("Details of “hooks”");
  });

  it("selects on a click; a double-click reveals the bar (start just inside the left edge) and opens the panel", async () => {
    const { user } = await panelBoard();
    const scrollTo = vi.fn();
    const scroller = screen.getByTestId("board-scroller");
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo;
    await user.click(rowOf("hooks").querySelector('[aria-label^="Row "]')!);
    expect(rowOf("hooks")).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(scrollTo).not.toHaveBeenCalled();
    await user.click(rowOf("hooks").querySelector('[aria-label^="Row "]')!); // clicking again changes nothing
    expect(scrollTo).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Working days of “hooks”" })); // opens the cell
    await user.keyboard("{Escape}");
    expect(scrollTo).not.toHaveBeenCalled();
    await selectRow(user, "hooks");
    expect(panel()).toHaveAccessibleName("Details of “hooks”");
    expect(scrollTo).toHaveBeenCalledTimes(1);
    const { left, behavior } = scrollTo.mock.calls[0]![0] as ScrollToOptions;
    // hooks starts Oct 12; the chart starts Mon Aug 31 at 32 px a day: its start lands 24 px inside the left edge
    expect(left).toBe(42 * 32 - 24);
    expect(behavior).toBe("smooth");
  });

  it("centers on a double-click on the row, but a double-click on a cell edits it instead", async () => {
    const { user } = await panelBoard();
    const scrollTo = vi.fn();
    const scroller = screen.getByTestId("board-scroller");
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo;
    const row = () => screen.getAllByRole("row").find((candidate) => within(candidate).queryByText("ui", { exact: true }))!;
    await user.dblClick(row().querySelector('[aria-label^="Row "]')!);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox", { name: "Title" })).not.toBeInTheDocument();
    await user.dblClick(screen.getByRole("button", { name: "Title “hooks”" }));
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("hooks");
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("has row buttons to show the bar on the chart and to open the details", async () => {
    const { user } = await panelBoard();
    const scrollTo = vi.fn();
    const scroller = screen.getByTestId("board-scroller");
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo;
    const show = within(rowOf("hooks")).getByRole("button", { name: "Show “hooks” on the chart" });
    const open = within(rowOf("hooks")).getByRole("button", { name: "Open details of “hooks”" });
    await user.click(show!);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(rowOf("hooks")).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    await user.click(open!);
    expect(panel()).toHaveAccessibleName("Details of “hooks”");
    expect(open).toHaveAttribute("aria-pressed", "true");
    expect(scrollTo).toHaveBeenCalledTimes(1);
    // On another row it moves the panel there; again on the same row it closes it.
    await user.click(within(rowOf("ui")).getByRole("button", { name: "Open details of “ui”" }));
    expect(panel()).toHaveAccessibleName("Details of “ui”");
    await user.click(within(rowOf("ui")).getByRole("button", { name: "Open details of “ui”" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(rowOf("ui")).toHaveAttribute("aria-selected", "true");
  });

  it("shows, posts and live-updates comments", async () => {
    const { api, user } = await panelBoard(ROWS, ADMIN, [comment("c2", { body: "**first** idea" }), comment("c1", { deleted: true, body: "" })]);
    const posted: unknown[] = [];
    api.on(`POST /api/projects/${PROJECT_ID}/comments`, (body) => {
      posted.push(body);
      return { status: 201, body: { comment: comment("c3", { body: (body as { body: string }).body, mine: true, author: { userId: ADMIN.id, label: ADMIN.name } }) } };
    });
    await selectRow(user, "hooks");
    const list = await within(panel()).findByText("first");
    expect(list.tagName).toBe("STRONG");
    // Each comment is its own card, led by the author's avatar and name.
    const card = list.closest("li")!;
    expect(card).toHaveClass("border");
    expect(within(card).getByText("R", { selector: "[aria-hidden]" })).toBeInTheDocument();
    expect(within(card).getByText("Rui")).toBeInTheDocument();
    expect(within(panel()).getByText("Comment deleted.")).toBeInTheDocument();
    expect(within(panel()).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument(); // not mine
    expect(within(panel()).getAllByRole("button", { name: "Delete" })).toHaveLength(1); // admins may delete any
    await user.type(within(panel()).getByRole("textbox", { name: "Write a comment" }), "ship it{Control>}{Enter}{/Control}");
    await waitFor(() => expect(posted).toEqual([{ taskId: "hooks", body: "ship it" }]));
    expect(await within(panel()).findByText("ship it")).toBeInTheDocument();
    expect(within(panel()).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    FakeWebSocket.last.deliver({ type: "comment", projectId: PROJECT_ID, comment: comment("c4", { body: "from Rui" }) });
    expect(await within(panel()).findByText("from Rui")).toBeInTheDocument();
    FakeWebSocket.last.deliver({ type: "comment", projectId: PROJECT_ID, comment: comment("c4", { body: "", deleted: true }) });
    await waitFor(() => expect(within(panel()).getAllByText("Comment deleted.")).toHaveLength(2));
  });

  it("shows the task's history, with share-link actors marked", async () => {
    const { user } = await panelBoard();
    await selectRow(user, "hooks");
    // Comments and history are tabs; comments come first and are shown by default.
    const tabs = within(panel()).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Comments", "History"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(within(panel()).getByRole("tabpanel", { name: "Comments" })).toBeVisible();
    expect(within(panel()).queryByText(/assigned it to Ana Silva/)).not.toBeVisible();
    tabs[0]!.focus();
    await user.keyboard("{ArrowRight}");
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveFocus();
    expect(within(panel()).getByRole("tabpanel", { name: "History" })).toBeVisible();
    expect(await within(panel()).findByText(/assigned it to Ana Silva/)).toBeVisible();
    expect(within(panel()).getByText("via share link")).toBeInTheDocument();
  });

  const links = () => within(panel()).getByRole("list", { name: "Links" });
  const lines = () => within(links()).getAllByRole("listitem");

  it("None + Add link when there are no links", async () => {
    const { user } = await panelBoard();
    await selectRow(user, "hooks");
    expect(within(panel()).getByText("None")).toBeVisible();
    expect(within(panel()).getByRole("button", { name: "Add link" })).toBeInTheDocument();
    expect(within(panel()).queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("one line per link with both dropdowns and ×, sorted by the other task's row", async () => {
    const { user } = await panelBoard(LINK_ROWS, ADMIN, [], [...LINKS].reverse());
    await selectRow(user, "hooks");
    expect(within(panel()).queryByText("None")).not.toBeInTheDocument();
    const [ui, qa] = lines();
    expect(lines()).toHaveLength(2);
    // hooks waits for ui to finish (FS); qa starts once hooks starts (SS, qa waits).
    const when = within(ui!).getByRole("combobox", { name: "Link with #2 ui: this task" });
    expect(when).toHaveDisplayValue("starts after");
    expect(within(when).getAllByRole("option").map((option) => option.textContent)).toEqual(["starts before", "starts after", "ends before", "ends after", "interrupted by", "interrupts"]);
    expect(within(ui!).getByRole("button", { name: "Link with #2 ui: change the task" })).toHaveTextContent("#2 ui");
    const end = within(ui!).getByRole("combobox", { name: "Link with #2 ui: the other task" });
    expect(end).toHaveDisplayValue("finished");
    expect(within(end).getAllByRole("option").map((option) => option.textContent)).toEqual(["finished", "started"]);
    expect(within(ui!).getByRole("button", { name: "Remove link with #2 ui" })).toBeInTheDocument();
    expect(within(qa!).getByRole("combobox", { name: "Link with #4 qa: this task" })).toHaveDisplayValue("starts before");
    expect(within(qa!).getByRole("combobox", { name: "Link with #4 qa: the other task" })).toHaveDisplayValue("started");
    // Fits on one line: the selects size to their words, the task takes the rest and truncates.
    for (const line of [ui!, qa!]) {
      expect(line).toHaveClass("flex");
      for (const select of within(line).getAllByRole("combobox")) {
        expect(select).not.toHaveClass("w-full");
        expect(select).toHaveClass("shrink-0");
      }
      const taskButton = within(line).getByRole("button", { name: /: change the task$/ });
      expect(taskButton).toHaveClass("min-w-0", "flex-1");
      expect(taskButton.querySelector(".truncate")).not.toBeNull();
    }
    expect(within(ui!).getByRole("button", { name: "Link with #2 ui: change the task" })).toHaveAttribute("title", "#2 ui");
    // No delay box: delays change by dragging.
    expect(within(links()).queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(within(panel()).queryByRole("spinbutton", { name: /delay/i })).not.toBeInTheDocument();
  });

  it('changing "finished" to "started" sends updateLink newKind SS, keeping focus there', async () => {
    const { user } = await panelBoard(LINK_ROWS, ADMIN, [], LINKS);
    await selectRow(user, "hooks");
    const end = () => within(panel()).getByRole("combobox", { name: "Link with #2 ui: the other task" });
    await user.selectOptions(end(), "started");
    expect(sentCommands().at(-1)).toEqual({ type: "updateLink", predecessorId: "ui", followerId: "hooks", kind: "FS", newKind: "SS" });
    expect(end()).toHaveDisplayValue("started");
    expect(end()).toHaveFocus();
    // Arrow keys on a closed select change it at once (Windows, Linux): each press is one change.
    const before = sentCommands().length;
    fireEvent.change(end(), { target: { value: "finished" } });
    expect(end()).toHaveFocus();
    expect(sentCommands().slice(before)).toEqual([{ type: "updateLink", predecessorId: "ui", followerId: "hooks", kind: "SS", newKind: "FS" }]);
  });

  it('changing "starts after" to "ends before" sends updateLink reverse + kind', async () => {
    const { user } = await panelBoard(LINK_ROWS, ADMIN, [], LINKS);
    await selectRow(user, "hooks");
    const when = () => within(panel()).getByRole("combobox", { name: "Link with #2 ui: this task" });
    await user.selectOptions(when(), "ends before");
    // hooks ends before ui finishes: ui now waits on hooks, finish to finish.
    expect(sentCommands().at(-1)).toEqual({ type: "updateLink", predecessorId: "ui", followerId: "hooks", kind: "FS", newKind: "FF", reverse: true });
    expect(when()).toHaveDisplayValue("ends before");
    expect(within(panel()).getByRole("combobox", { name: "Link with #2 ui: the other task" })).toHaveDisplayValue("finished");
    expect(when()).toHaveFocus();
    // Turned around with the same kind: reverse alone.
    await user.selectOptions(when(), "ends after");
    expect(sentCommands().at(-1)).toEqual({ type: "updateLink", predecessorId: "hooks", followerId: "ui", kind: "FF", reverse: true });
  });

  it("picking another task sends removeLink then addLink", async () => {
    const rows = [...LINK_ROWS, task("docs", { parentId: "x", position: "a3", userStart: "2026-10-22", duration: 1 })];
    const { user } = await panelBoard(rows, ADMIN, [], LINKS);
    await selectRow(user, "hooks");
    await user.click(within(panel()).getByRole("button", { name: "Link with #2 ui: change the task" }));
    const offered = within(screen.getByRole("listbox")).getAllByRole("option").map((option) => option.textContent);
    expect(offered).toEqual([expect.stringMatching(/^#4 qa/), expect.stringMatching(/^#5 docs/)]); // not hooks, the section or ui (this link)
    // qa already waits on hooks: waiting on qa would go round in a circle, so nothing is sent.
    await user.type(screen.getByRole("combobox", { name: "Find a task to link" }), "qa{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/circle|cycle|loop/i);
    const before = sentCommands().length;
    await user.click(within(panel()).getByRole("button", { name: "Link with #2 ui: change the task" }));
    await user.type(screen.getByRole("combobox", { name: "Find a task to link" }), "docs{Enter}");
    expect(sentCommands().slice(before)).toEqual([
      {
        type: "relink",
        steps: [
          { type: "removeLink", predecessorId: "ui", followerId: "hooks", kind: "FS", keepPlace: false },
          { type: "addLink", predecessorId: "docs", followerId: "hooks", kind: "FS", lag: 2 }, // the delay carries over
        ],
      },
    ]);
    await waitFor(() => expect(within(panel()).getByRole("button", { name: "Link with #5 docs: change the task" })).toHaveFocus());
    expect(within(panel()).queryByRole("button", { name: /^Link with #2 ui/ })).not.toBeInTheDocument();
  });

  it("picking another task keeps the delay", async () => {
    const rows = [...LINK_ROWS, task("docs", { parentId: "x", position: "a3", userStart: "2026-10-22", duration: 1 })];
    const { user } = await panelBoard(rows, ADMIN, [], [{ predecessorId: "ui", followerId: "hooks", kind: "FS", lag: -1 }, { predecessorId: "hooks", followerId: "qa", kind: "SS", lag: 1.5 }]);
    await selectRow(user, "hooks");
    await user.click(within(panel()).getByRole("button", { name: "Link with #4 qa: change the task" }));
    await user.type(screen.getByRole("combobox", { name: "Find a task to link" }), "docs{Enter}");
    expect(sentCommands().at(-1)).toEqual({
      type: "relink",
      steps: [
        { type: "removeLink", predecessorId: "hooks", followerId: "qa", kind: "SS", keepPlace: false },
        { type: "addLink", predecessorId: "hooks", followerId: "docs", kind: "SS", lag: 1.5 },
      ],
    });
    // An overlap (FS only) carries over too.
    await user.click(within(panel()).getByRole("button", { name: "Link with #2 ui: change the task" }));
    await user.type(screen.getByRole("combobox", { name: "Find a task to link" }), "qa{Enter}");
    expect(sentCommands().at(-1)).toEqual({
      type: "relink",
      steps: [
        { type: "removeLink", predecessorId: "ui", followerId: "hooks", kind: "FS", keepPlace: false },
        { type: "addLink", predecessorId: "qa", followerId: "hooks", kind: "FS", lag: -1 },
      ],
    });
  });

  it("goes to the linked task from its picker", async () => {
    const { user } = await panelBoard(LINK_ROWS, ADMIN, [], LINKS);
    await selectRow(user, "hooks");
    await user.click(within(panel()).getByRole("button", { name: "Link with #2 ui: change the task" }));
    await user.click(screen.getByRole("button", { name: "Go to #2 ui" }));
    expect(panel()).toHaveAccessibleName("Details of “ui”");
    expect(within(panel()).getByRole("combobox", { name: "Link with #3 hooks: this task" })).toHaveDisplayValue("ends before");
  });

  it("draft line: × discards; pick sends addLink; refusal keeps the draft and shows the message", async () => {
    const rows = [...ROWS, task("idea", { parentId: "x", position: "a2", duration: 1 })];
    const { user } = await panelBoard(rows);
    await selectRow(user, "hooks");
    const add = () => within(panel()).getByRole("button", { name: "Add link" });
    await user.click(add());
    // The draft opens on its task list; Escape leaves the line.
    expect(screen.getByRole("combobox", { name: "Find a task to link" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(within(panel()).queryByText("None")).not.toBeInTheDocument();
    for (const select of within(lines()[0]!).getAllByRole("combobox")) expect(select).not.toHaveClass("w-full"); // looks like the other lines
    expect(within(panel()).getByRole("combobox", { name: "New link: this task" })).toHaveDisplayValue("starts after");
    expect(within(panel()).getByRole("button", { name: "New link: choose a task" })).toHaveTextContent("choose a task…");
    expect(within(panel()).getByRole("combobox", { name: "New link: the other task" })).toHaveDisplayValue("finished");
    await user.click(add()); // at most one draft
    await user.keyboard("{Escape}");
    expect(lines()).toHaveLength(1);
    await user.click(within(panel()).getByRole("button", { name: "Discard the new link" }));
    expect(within(panel()).getByText("None")).toBeVisible();
    expect(add()).toHaveFocus();
    expect(sentCommands()).toEqual([]);

    // Refused (no dates): the draft stays and the reason shows.
    await user.click(add());
    await user.type(screen.getByRole("combobox", { name: "Find a task to link" }), "idea{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Both tasks need dates before they can be linked");
    expect(sentCommands()).toEqual([]);
    expect(within(panel()).getByRole("button", { name: "New link: choose a task" })).toBeInTheDocument();

    // ends after … finished: hooks can't finish before ui finishes (FF).
    await user.selectOptions(within(panel()).getByRole("combobox", { name: "New link: this task" }), "ends after");
    await user.click(within(panel()).getByRole("button", { name: "New link: choose a task" }));
    await user.type(screen.getByRole("combobox", { name: "Find a task to link" }), "ui{Enter}");
    expect(sentCommands()).toEqual([{ type: "addLink", predecessorId: "ui", followerId: "hooks", kind: "FF" }]);
    expect(within(panel()).queryByRole("button", { name: "New link: choose a task" })).not.toBeInTheDocument();
    expect(within(panel()).getByRole("combobox", { name: "Link with #2 ui: this task" })).toHaveDisplayValue("ends after");
  });

  it("the picker leaves out the task itself, sections, its parents and subtasks, and tasks linked the same way", async () => {
    const rows = [
      section("x", { position: "a0" }),
      task("plan", { parentId: "x", position: "a0", title: "plan" }),
      task("build", { parentId: "plan", position: "a0", title: "build" }),
      task("code", { parentId: "build", position: "a0", userStart: "2026-10-01", duration: 2, title: "code" }),
      task("ship", { parentId: "x", position: "a1", userStart: "2026-10-12", duration: 1, title: "ship" }),
      task("docs", { parentId: "x", position: "a2", userStart: "2026-10-14", duration: 1, title: "docs" }),
    ];
    const { user } = await panelBoard(rows, ADMIN, [], [{ predecessorId: "ship", followerId: "build", kind: "FS", lag: 0 }]);
    await selectRow(user, "build");
    await user.click(within(panel()).getByRole("button", { name: "Add link" }));
    const offered = () => within(screen.getByRole("listbox")).getAllByRole("option").map((option) => option.textContent);
    expect(offered()).toEqual([expect.stringMatching(/^#6 docs/)]); // not itself, the section, its parent, its subtask or ship (already waited on)
    await user.keyboard("{Escape}");
    // ends before … started: the other task waits on this one (FS).
    await user.selectOptions(within(panel()).getByRole("combobox", { name: "New link: this task" }), "ends before");
    await user.selectOptions(within(panel()).getByRole("combobox", { name: "New link: the other task" }), "started");
    await user.click(within(panel()).getByRole("button", { name: "New link: choose a task" }));
    expect(offered()).toEqual([expect.stringMatching(/^#5 ship/), expect.stringMatching(/^#6 docs/)]);
    await user.type(screen.getByRole("combobox", { name: "Find a task to link" }), "docs{Enter}");
    expect(sentCommands().at(-1)).toEqual({ type: "addLink", predecessorId: "build", followerId: "docs", kind: "FS" });
  });

  it("after × the focus moves to the next line's ×, then to + Add link when none is left", async () => {
    const { user } = await panelBoard(LINK_ROWS, ADMIN, [], LINKS);
    await selectRow(user, "hooks");
    await user.click(within(panel()).getByRole("button", { name: "Remove link with #2 ui" }));
    expect(sentCommands().at(-1)).toEqual({ type: "removeLink", predecessorId: "ui", followerId: "hooks", kind: "FS" });
    await waitFor(() => expect(within(panel()).getByRole("button", { name: "Remove link with #4 qa" })).toHaveFocus());
    await user.keyboard("{Enter}");
    expect(sentCommands().at(-1)).toEqual({ type: "removeLink", predecessorId: "hooks", followerId: "qa", kind: "SS" });
    await waitFor(() => expect(within(panel()).getByRole("button", { name: "Add link" })).toHaveFocus());
    expect(within(panel()).getByText("None")).toBeVisible();
  });

  it("viewers see plain text", async () => {
    const { user } = await panelBoard(LINK_ROWS, VIEWER, [], LINKS);
    await selectRow(user, "hooks");
    expect(lines().map((line) => line.textContent)).toEqual(["starts after #2 ui finished", "starts before #4 qa started"]);
    expect(within(panel()).queryByRole("combobox", { name: /^(Link with|New link)/ })).not.toBeInTheDocument();
    expect(within(panel()).queryByRole("button", { name: /^(Add link|Remove link with|Link with)/ })).not.toBeInTheDocument();
    await user.click(within(lines()[0]!).getByRole("button", { name: "#2 ui" })); // goes to the linked task
    expect(panel()).toHaveAccessibleName("Details of “ui”");
  });

  describe("interruptions", () => {
    const MON = "2026-10-12";
    const interruptionsBoard = async (fields: Partial<TaskRow> = {}, user = ADMIN, extra: ProjectStateDto["rows"] = []) => {
      const rows = [ROWS[0]!, task("t", { parentId: "x", position: "a1", userStart: MON, duration: 2, ...fields }), ...extra];
      const app = await panelBoard(rows, user, [], []);
      await selectRow(app.user, "t");
      return app;
    };
    const section = () => within(panel()).getByRole("heading", { name: "Interruptions" }).closest("section")!;
    const lastCommand = () => sentCommands().at(-1);
    const from = () => within(section()).getByLabelText(/^Interrupted from/);
    const to = () => within(section()).getByLabelText(/^Interrupted until/);
    const setDate = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } });

    it("sits above Links, only for tasks with work of their own", async () => {
      await interruptionsBoard();
      const titles = within(panel()).getAllByRole("heading").map((heading) => heading.textContent);
      expect(titles.indexOf("Interruptions")).toBe(titles.indexOf("Links") - 1);
    });

    it("isn't there for milestones", async () => {
      await interruptionsBoard({ duration: 0 });
      expect(within(panel()).queryByRole("heading", { name: "Interruptions" })).not.toBeInTheDocument();
    });

    it("adds one: Save sends where it starts and the working day after it ends", async () => {
      const { user } = await interruptionsBoard();
      await user.click(within(section()).getByRole("button", { name: "Add interruption" }));
      setDate(from(), "2026-10-13");
      setDate(to(), "2026-10-15");
      await user.click(within(section()).getByRole("button", { name: "Save" }));
      expect(lastCommand()).toEqual({ type: "addBreak", id: "t", from: "2026-10-13", resume: "2026-10-16" });
    });

    it("a refused one shows why, and the draft stays", async () => {
      const { user } = await interruptionsBoard();
      await user.click(within(section()).getByRole("button", { name: "Add interruption" }));
      setDate(from(), "2026-11-20");
      setDate(to(), "2026-11-25");
      await user.click(within(section()).getByRole("button", { name: "Save" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(/inside the task/);
      expect(from()).toHaveValue("2026-11-20");
    });

    it("an end before the start is refused: a new one's draft stays, a stored one stays as it was", async () => {
      const { user } = await interruptionsBoard();
      await user.click(within(section()).getByRole("button", { name: "Add interruption" }));
      setDate(from(), "2026-10-13");
      setDate(to(), "2026-10-12");
      await user.click(within(section()).getByRole("button", { name: "Save" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(/end after it starts/);
      expect(from()).toHaveValue("2026-10-13");
    });

    it("a stored one reads back its dates and what it does", async () => {
      await interruptionsBoard({ breaks: [{ after: 2, length: 6 }] });
      expect(from()).toHaveValue("2026-10-13");
      expect(to()).toHaveValue("2026-10-15");
      expect(within(section()).getByText(new RegExp(`^Still 2 days of work\\. Now finishes ${formatDay(toDay("2026-10-16"))}\\.$`))).toBeInTheDocument();
    });

    it("changing its dates and saving is one change; × removes it", async () => {
      const { user } = await interruptionsBoard({ breaks: [{ after: 2, length: 6 }] });
      expect(within(section()).queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
      setDate(to(), "2026-10-14");
      await user.click(within(section()).getByRole("button", { name: "Save" }));
      expect(lastCommand()).toEqual({
        type: "relink",
        steps: [
          { type: "removeBreak", id: "t", after: 2 },
          { type: "addBreak", id: "t", from: "2026-10-13", resume: "2026-10-15" },
        ],
      });
      await user.click(within(section()).getByRole("button", { name: /^Remove interruption/ }));
      expect(lastCommand()).toMatchObject({ type: "removeBreak", id: "t" });
    });

    it("saving a change keeps the half day of the end that didn't move", async () => {
      const { user } = await interruptionsBoard({ breaks: [{ after: 1, length: 3 }] }); // off from Monday afternoon, back Wednesday morning
      expect(from()).toHaveValue("2026-10-12");
      setDate(to(), "2026-10-14");
      await user.click(within(section()).getByRole("button", { name: "Save" }));
      expect(lastCommand()).toEqual({
        type: "relink",
        steps: [
          { type: "removeBreak", id: "t", after: 1 },
          { type: "addBreak", id: "t", from: "2026-10-12", fromHalf: "afternoon", resume: "2026-10-15" },
        ],
      });
    });

    it("viewers read them", async () => {
      await interruptionsBoard({ breaks: [{ after: 2, length: 6 }] }, VIEWER);
      expect(within(section()).queryByRole("button")).not.toBeInTheDocument();
      expect(section()).toHaveTextContent(new RegExp(`${formatDay(toDay("2026-10-13"))} to ${formatDay(toDay("2026-10-15"))}`));
    });

    describe("in Links", () => {
      const links = () => within(panel()).getByRole("list", { name: "Links" });
      const hotfix = task("hotfix", { parentId: "x", position: "a2", userStart: "2026-10-13", duration: 3 });
      const free = task("free", { parentId: "x", position: "a3", userStart: "2026-10-20", duration: 1 });
      const whenOfLine = () => within(links()).getAllByRole("combobox").find((box) => (box as HTMLSelectElement).options.length > 0)!;

      it("lists who interrupts it, and offers another task", async () => {
        const { user } = await interruptionsBoard({ interruptedBy: ["hotfix"] }, ADMIN, [hotfix, free]);
        expect(whenOfLine()).toHaveValue("interrupted by");
        await user.click(within(links()).getByRole("button", { name: /hotfix: change the task/ }));
        await user.type(await screen.findByRole("combobox", { name: "Find a task to interrupt with" }), "free{Enter}");
        expect(lastCommand()).toEqual({
          type: "relink",
          steps: [
            { type: "removeInterruption", id: "t", byId: "hotfix" },
            { type: "addInterruption", id: "t", byId: "free" },
          ],
        });
      });

      it("the other task lists it as interrupts", async () => {
        const { user } = await interruptionsBoard({ interruptedBy: ["hotfix"] }, ADMIN, [hotfix]);
        await selectRow(user, "hotfix");
        expect(whenOfLine()).toHaveValue("interrupts");
        await user.click(within(links()).getByRole("button", { name: /^Stop .* interrupting/ }));
        expect(lastCommand()).toEqual({ type: "removeInterruption", id: "t", byId: "hotfix" });
      });

      it("turns into a link, and flips", async () => {
        const { user } = await interruptionsBoard({ interruptedBy: ["hotfix"] }, ADMIN, [hotfix]);
        await user.selectOptions(whenOfLine(), "starts after");
        expect(lastCommand()).toEqual({
          type: "relink",
          steps: [
            { type: "removeInterruption", id: "t", byId: "hotfix" },
            { type: "addLink", predecessorId: "hotfix", followerId: "t", kind: "FS" },
          ],
        });
      });

      it("flipping it swaps who interrupts whom, as one change", async () => {
        const { user } = await interruptionsBoard({ interruptedBy: ["hotfix"] }, ADMIN, [hotfix]);
        await user.selectOptions(whenOfLine(), "interrupts");
        expect(lastCommand()).toEqual({
          type: "relink",
          steps: [
            { type: "removeInterruption", id: "t", byId: "hotfix" },
            { type: "addInterruption", id: "hotfix", byId: "t" },
          ],
        });
      });

      it("a link turns into one", async () => {
        const { user } = await panelBoard([ROWS[0]!, task("t", { parentId: "x", position: "a1", userStart: "2026-10-20", duration: 2 }), hotfix], ADMIN, [], [{ predecessorId: "hotfix", followerId: "t", kind: "FS", lag: 0 }]);
        await selectRow(user, "t");
        await user.selectOptions(whenOfLine(), "interrupted by");
        expect(lastCommand()).toEqual({
          type: "relink",
          steps: [
            { type: "removeLink", predecessorId: "hotfix", followerId: "t", kind: "FS", keepPlace: false },
            { type: "addInterruption", id: "t", byId: "hotfix" },
          ],
        });
      });

      it("+ Add link offers both", async () => {
        const { user } = await interruptionsBoard({}, ADMIN, [hotfix]);
        await user.click(within(panel()).getByRole("button", { name: "Add link" }));
        await user.keyboard("{Escape}");
        await user.selectOptions(within(panel()).getByRole("combobox", { name: "New link: this task" }), "interrupted by");
        await user.type(await screen.findByRole("combobox", { name: "Find a task to interrupt with" }), "hotfix{Enter}");
        expect(lastCommand()).toEqual({ type: "addInterruption", id: "t", byId: "hotfix" });
      });

      it("viewers read the line", async () => {
        await interruptionsBoard({ interruptedBy: ["hotfix"] }, VIEWER, [hotfix]);
        expect(within(links()).getByRole("listitem")).toHaveTextContent(/^interrupted by #\d+ hotfix/);
      });
    });
  });

  describe("aiming for", () => {
    const aimBoard = async (fields: Partial<TaskRow> = {}, user = ADMIN, extra: ProjectStateDto["rows"] = [], links: Link[] = []) => {
      const rows = [
        ROWS[0]!,
        task("hooks", { parentId: "x", position: "a1", userStart: "2026-10-12", duration: 2, ...fields }),
        task("later", { parentId: "x", position: "a2", userStart: "2026-10-23", duration: 0 }),
        task("soon", { parentId: "x", position: "a3", userStart: "2026-10-14", duration: 0 }),
        task("undated", { parentId: "x", position: "a4", duration: 0 }),
        ...extra,
      ];
      const app = await panelBoard(rows, user, [], links);
      await selectRow(app.user, "hooks");
      return app;
    };
    const aimSection = () => within(panel()).getByRole("heading", { name: "Links" }).closest("section")!;
    const newLinkWhen = () => within(aimSection()).getByRole("combobox", { name: "New link: this task" });
    /** + Add link, then "aims for". */
    const openAim = async (user: UserEvent) => {
      await user.click(within(aimSection()).getByRole("button", { name: "Add link" }));
      await user.selectOptions(newLinkWhen(), "aims for");
    };
    const offered = () => within(within(aimSection()).getByRole("listbox")).getAllByRole("option").map((option) => option.textContent);
    const lastCommand = () => sentCommands().at(-1);
    const dayOf = (iso: string) => formatDay(toDay(iso));

    it("has no box of its own: it's a choice in + Add link, and the picker opens at once", async () => {
      const { user } = await aimBoard();
      expect(within(panel()).queryByRole("heading", { name: "Aiming for" })).not.toBeInTheDocument();
      await user.click(within(aimSection()).getByRole("button", { name: "Add link" }));
      expect(within(newLinkWhen()).getAllByRole<HTMLOptionElement>("option").map((option) => option.value)[0]).toBe("aims for");
      await user.selectOptions(newLinkWhen(), "aims for");
      expect(within(aimSection()).getByRole("combobox", { name: "Aims for: choose a milestone" })).toHaveFocus();
      expect(within(aimSection()).getByRole("listbox")).toBeInTheDocument();
    });

    it("isn't offered on a milestone", async () => {
      const { user } = await aimBoard();
      await selectRow(user, "soon");
      await user.click(within(aimSection()).getByRole("button", { name: "Add link" }));
      expect(within(newLinkWhen()).getAllByRole<HTMLOptionElement>("option").map((option) => option.value)).not.toContain("aims for");
    });

    describe("from the milestone's side", () => {
      const linkLines = () => within(aimSection()).getAllByRole("listitem");
      const whenOf = (line: HTMLElement) => within(line).getAllByRole("combobox")[0]!;

      it("lists what aims for it as aimed by, with how each stands, not subtasks that only inherit", async () => {
        const { user } = await aimBoard({ targetId: "soon", duration: 5 }, ADMIN, [
          task("aimer", { parentId: "x", position: "a5", userStart: "2026-10-12", duration: 1, targetId: "soon" }),
          task("other", { parentId: "x", position: "a6", userStart: "2026-10-12", duration: 1, targetId: "later" }),
          task("kid", { parentId: "aimer", position: "a0", userStart: "2026-10-12", duration: 1 }),
        ]);
        await selectRow(user, "soon");
        const lines = linkLines();
        expect(lines).toHaveLength(2);
        expect(whenOf(lines[0]!)).toHaveValue("aimed by");
        expect(within(lines[0]!).getByRole("button", { name: /hooks: change the task/ })).toBeInTheDocument();
        expect(within(lines[0]!).getByText(/2 days late/)).toBeInTheDocument();
        expect(within(lines[1]!).getByRole("button", { name: /aimer: change the task/ })).toBeInTheDocument();
      });

      it("+ Add link offers aimed by, not aims for, and picking a task aims it here", async () => {
        const { user } = await aimBoard();
        await selectRow(user, "soon");
        await user.click(within(aimSection()).getByRole("button", { name: "Add link" }));
        const options = within(newLinkWhen()).getAllByRole<HTMLOptionElement>("option").map((option) => option.value);
        expect(options[0]).toBe("aimed by");
        expect(options).not.toContain("aims for");
        await user.selectOptions(newLinkWhen(), "aimed by");
        const search = await screen.findByRole("combobox", { name: "Find a task to aim here" });
        await user.type(search, "hooks{Enter}");
        expect(lastCommand()).toEqual({ type: "setTarget", id: "hooks", targetId: "soon" });
      });

      it("offers tasks only: no milestones, sections, or what already aims here", async () => {
        const { user } = await aimBoard({ targetId: "soon" }, ADMIN, [task("free", { parentId: "x", position: "a5", userStart: "2026-10-12" })]);
        await selectRow(user, "soon");
        await user.click(within(aimSection()).getByRole("button", { name: "Add link" }));
        await user.selectOptions(newLinkWhen(), "aimed by");
        const search = await screen.findByRole("combobox", { name: "Find a task to aim here" });
        expect(search).toBeInTheDocument();
        const offered = screen.getAllByRole("option").filter((option) => /#\d+ /.test(option.textContent ?? "")).map((option) => option.textContent);
        expect(offered).toHaveLength(1);
        expect(offered[0]).toMatch(/free/);
      });

      it("× stops that task aiming here", async () => {
        const { user } = await aimBoard({ targetId: "soon" });
        await selectRow(user, "soon");
        await user.click(within(aimSection()).getByRole("button", { name: "Stop “hooks” aiming here" }));
        expect(lastCommand()).toEqual({ type: "setTarget", id: "hooks", targetId: null });
      });

      it("changing the task moves the aim to the new one", async () => {
        const { user } = await aimBoard({ targetId: "soon" }, ADMIN, [task("free", { parentId: "x", position: "a5", userStart: "2026-10-12" })]);
        await selectRow(user, "soon");
        await user.click(within(aimSection()).getByRole("button", { name: /hooks: change the task/ }));
        await user.type(await screen.findByRole("combobox", { name: "Find a task to aim here" }), "free{Enter}");
        expect(sentCommands().at(-1)).toEqual({
          type: "relink",
          steps: [
            { type: "setTarget", id: "free", targetId: "soon" },
            { type: "setTarget", id: "hooks", targetId: null },
          ],
        });
      });

      it("the first dropdown turns it into a link, and a link with a task into aimed by", async () => {
        const { user } = await aimBoard({}, ADMIN, [task("ui", { parentId: "x", position: "a5", userStart: "2026-10-12", duration: 1 })], [{ predecessorId: "ui", followerId: "soon", kind: "FS", lag: 0 }]);
        await selectRow(user, "soon");
        const linkLine = linkLines().find((line) => within(line).queryByRole("button", { name: /ui: change the task/ }))!;
        await user.selectOptions(whenOf(linkLine), "aimed by");
        expect(sentCommands().at(-1)).toEqual({
          type: "relink",
          steps: [
            { type: "removeLink", predecessorId: "ui", followerId: "soon", kind: "FS" }, // nothing moves
            { type: "setTarget", id: "ui", targetId: "soon" },
          ],
        });
      });

      it("turning a link into an aim turns Critical path on; turning an aim into a link doesn't", async () => {
        useCriticalPathView.setState({ on: { [PROJECT_ID]: false }, defaults: {} });
        try {
          const { user } = await aimBoard({ targetId: "soon" });
          await selectRow(user, "soon");
          await user.selectOptions(whenOf(linkLines()[0]!), "starts after");
          await waitFor(() => expect(sentCommands().at(-1)).toMatchObject({ type: "relink" }));
          expect(isCriticalPathOn(PROJECT_ID)).toBe(false);
          await user.selectOptions(whenOf(linkLines()[0]!), "aimed by");
          await waitFor(() => expect(sentCommands().at(-1)).toMatchObject({ steps: [{ type: "removeLink" }, { type: "setTarget" }] }));
          expect(isCriticalPathOn(PROJECT_ID)).toBe(true);
        } finally {
          useCriticalPathView.setState({ on: {}, defaults: {} });
        }
      });

      it("the aimed-by line turns into a link", async () => {
        const { user } = await aimBoard({ targetId: "soon" });
        await selectRow(user, "soon");
        await user.selectOptions(whenOf(linkLines()[0]!), "starts after");
        expect(sentCommands().at(-1)).toEqual({
          type: "relink",
          steps: [
            { type: "setTarget", id: "hooks", targetId: null },
            { type: "addLink", predecessorId: "hooks", followerId: "soon", kind: "FS" },
          ],
        });
      });

      it("viewers read the lines", async () => {
        const { user } = await aimBoard({ targetId: "soon" }, VIEWER);
        await selectRow(user, "soon");
        expect(linkLines()[0]).toHaveTextContent(/^aimed by #\d+ hooks/);
        expect(within(aimSection()).queryByRole("combobox")).not.toBeInTheDocument();
      });
    });

    it("lists as the first line, with how it stands under it, ahead of the links", async () => {
      await aimBoard({ targetId: "soon", duration: 5 }, ADMIN, [task("first", { parentId: "x", position: "a0", userStart: "2026-10-05" })]);
      const lines = within(aimSection()).getAllByRole("listitem");
      expect(within(lines[0]!).getByRole("combobox", { name: /^Aims for/ })).toHaveValue("aims for");
      expect(within(lines[0]!).getByRole("button", { name: /change the milestone/ })).toHaveTextContent("soon");
      expect(within(lines[0]!).getByText(/2 days late/)).toBeInTheDocument();
    });

    it("keeps the keyboard's place: after picking on the line, and after ×", async () => {
      const { user } = await aimBoard({ targetId: "later" });
      await user.click(within(aimSection()).getByRole("button", { name: /change the milestone/ }));
      await user.keyboard("{ArrowDown}{Enter}");
      await waitFor(() => expect(within(aimSection()).getByRole("button", { name: /change the milestone/ })).toHaveFocus());
      await user.click(within(aimSection()).getByRole("button", { name: /^Stop aiming/ }));
      await waitFor(() => expect(within(aimSection()).getByRole("button", { name: "Add link" })).toHaveFocus());
    });

    it("from + Add link, focus lands on the new line", async () => {
      const { user } = await aimBoard();
      await user.click(within(aimSection()).getByRole("button", { name: "Add link" }));
      await user.keyboard("{Escape}");
      await user.selectOptions(newLinkWhen(), "aims for");
      await user.keyboard("{ArrowDown}{Enter}");
      await waitFor(() => expect(within(aimSection()).getByRole("combobox", { name: /^Aims for/ })).toHaveFocus());
    });

    it("changing an aim leaves Critical path as it is", async () => {
      useCriticalPathView.setState({ on: { [PROJECT_ID]: false }, defaults: {} });
      try {
        const { user } = await aimBoard({ targetId: "later" });
        await user.click(within(aimSection()).getByRole("button", { name: /change the milestone/ }));
        await user.click(within(within(aimSection()).getByRole("listbox")).getAllByRole("option")[0]!);
        expect(lastCommand()).toEqual({ type: "setTarget", id: "hooks", targetId: "soon" });
        expect(isCriticalPathOn(PROJECT_ID)).toBe(false);
      } finally {
        useCriticalPathView.setState({ on: {}, defaults: {} });
      }
    });

    it("the milestone can be changed from its line", async () => {
      const { user } = await aimBoard({ targetId: "later" });
      await user.click(within(aimSection()).getByRole("button", { name: /change the milestone/ }));
      await user.click(within(within(aimSection()).getByRole("listbox")).getAllByRole("option")[0]!);
      expect(lastCommand()).toEqual({ type: "setTarget", id: "hooks", targetId: "soon" });
    });

    it("the first dropdown turns an aim into a link", async () => {
      const { user } = await aimBoard({ targetId: "later" });
      await user.selectOptions(within(aimSection()).getByRole("combobox", { name: /^Aims for/ }), "starts after");
      expect(sentCommands().at(-1)).toEqual({
        type: "relink",
        steps: [
          { type: "setTarget", id: "hooks", targetId: null },
          { type: "addLink", predecessorId: "later", followerId: "hooks", kind: "FS" },
        ],
      });
    });

    it("clicking offers the board's milestones soonest first with dates, undated last, none highlighted", async () => {
      const { user } = await aimBoard();
      await openAim(user);
      expect(offered()).toEqual([`#4 soon${dayOf("2026-10-14")}`, `#3 later${dayOf("2026-10-23")}`, "#5 undatedno date"]);
      for (const option of within(within(aimSection()).getByRole("listbox")).getAllByRole("option")) expect(option).toHaveAttribute("aria-selected", "false");
      expect(within(aimSection()).getByRole("listbox").className).toContain("fixed");
    });

    it("typing narrows and highlights the first; an exact name offers no Create, whatever its case", async () => {
      const { user } = await aimBoard();
      await openAim(user);
      await user.keyboard("o");
      expect(offered()).toEqual([`#4 soon${dayOf("2026-10-14")}`, '+ Create "o"']);
      expect(within(within(aimSection()).getByRole("listbox")).getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
      await user.keyboard("{Backspace}SOON");
      expect(offered()).toEqual([`#4 soon${dayOf("2026-10-14")}`]);
    });

    it("Enter on the empty box sets nothing; ↓ then Enter aims", async () => {
      const { user } = await aimBoard();
      await openAim(user);
      await user.keyboard("{Enter}");
      expect(sentCommands().filter((command) => command.type === "setTarget")).toEqual([]);
      await user.keyboard("{ArrowDown}{Enter}");
      expect(lastCommand()).toEqual({ type: "setTarget", id: "hooks", targetId: "soon" });
    });

    it("clicking a milestone aims for it", async () => {
      const { user } = await aimBoard();
      await openAim(user);
      await user.click(within(within(aimSection()).getByRole("listbox")).getAllByRole("option")[1]!);
      expect(lastCommand()).toEqual({ type: "setTarget", id: "hooks", targetId: "later" });
    });

    it("+ Create makes one command, starting on the task's finish, and the date shows focused until the box is left", async () => {
      const { user } = await aimBoard();
      await openAim(user);
      await user.keyboard("8.12{Enter}");
      expect(lastCommand()).toMatchObject({ type: "createTargetMilestone", id: "hooks", title: "8.12", start: "2026-10-13" });
      const date = within(aimSection()).getByLabelText("Milestone date");
      expect(date).toHaveFocus();
      expect(date).toHaveValue("2026-10-13");
      const created = (lastCommand() as { newId: string }).newId;
      fireEvent.change(date, { target: { value: "2026-10-20" } });
      expect(lastCommand()).toMatchObject({ type: "createTargetMilestone" }); // nothing moves until it's committed
      fireEvent.keyDown(date, { key: "Enter" });
      expect(lastCommand()).toEqual({ type: "moveTask", id: created, start: "2026-10-20" });
      await user.click(within(panel()).getByRole("combobox", { name: "Add tag" }));
      expect(within(aimSection()).queryByLabelText("Milestone date")).not.toBeInTheDocument();
    });

    it("+ Create starts today when the task has no dates", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 9, 7, 12));
      try {
        const { user } = await aimBoard({ userStart: null });
        await openAim(user);
        await user.keyboard("8.12{Enter}");
        expect(lastCommand()).toMatchObject({ type: "createTargetMilestone", start: "2026-10-07" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("goes after the last milestone being aimed at, else at the end of the board", () => {
      const rows = (aimed: boolean) => {
        const list = [section("s", { position: "a0" }), task("m", { parentId: "s", position: "a0", duration: 0 }), task("t", { position: "a1", targetId: aimed ? "m" : null })];
        return newMilestonePlace({ rows: Object.fromEntries(list.map((row) => [row.id, row])), links: {} });
      };
      expect(rows(true)).toEqual({ parentId: "s", afterId: "m" });
      expect(rows(false)).toEqual({ parentId: null, afterId: "t" });
    });

    it("says how late it is, or how much is to spare", async () => {
      await aimBoard({ targetId: "soon", duration: 5 }); // finishes Fri 16, milestone Wed 14
      expect(within(aimSection()).getByText(`2 days late: finishes ${dayOf("2026-10-16")}, milestone is ${dayOf("2026-10-14")}`)).toBeInTheDocument();
    });

    it("counts one day late, to spare and exactly on time", async () => {
      const { user } = await aimBoard({ targetId: "later" }); // finishes Tue 13, milestone Fri 23
      expect(within(aimSection()).getByText("8 days to spare")).toBeInTheDocument();
      await user.click(within(aimSection()).getByRole("button", { name: "Stop aiming for “later”" }));
      expect(lastCommand()).toEqual({ type: "setTarget", id: "hooks", targetId: null });
      expect(rowOf("later")).toBeInTheDocument();
    });

    it("says an undated milestone has no date yet", async () => {
      await aimBoard({ targetId: "undated" });
      expect(within(aimSection()).getByText("No date yet")).toBeInTheDocument();
    });

    it("a subtask shows its parent's target as inherited, and can replace it", async () => {
      const { user } = await aimBoard({ targetId: "later" }, ADMIN, [task("kid", { parentId: "hooks", position: "a0", userStart: "2026-10-12", duration: 1 })]);
      await selectRow(user, "kid");
      expect(within(aimSection()).getByText(/ later$/)).toBeInTheDocument();
      expect(within(aimSection()).getByText("From hooks · 9 days to spare")).toBeInTheDocument();
      expect(within(aimSection()).queryByRole("button", { name: /^Stop aiming/ })).not.toBeInTheDocument();
      await openAim(user);
      await user.click(within(within(aimSection()).getByRole("listbox")).getAllByRole("option")[0]!);
      expect(lastCommand()).toEqual({ type: "setTarget", id: "kid", targetId: "soon" });
    });

    it("viewers see the name and result only, or None", async () => {
      await aimBoard({ targetId: "later" }, VIEWER);
      expect(within(aimSection()).getByText(/ later$/)).toBeInTheDocument();
      expect(within(aimSection()).getByText("8 days to spare")).toBeInTheDocument();
      expect(within(aimSection()).queryByRole("combobox")).not.toBeInTheDocument();
      expect(within(aimSection()).queryByRole("button", { name: /Stop aiming|change the milestone/ })).not.toBeInTheDocument();
    });

    it("viewers see None with no target and no links", async () => {
      await aimBoard({}, VIEWER);
      expect(within(aimSection()).getByText("None")).toBeInTheDocument();
    });
  });

  describe("tags", () => {
    const tagsBoard = async (tags: string[] = [], user = ADMIN, known: string[] = ["UI", "UX research", "Q4 · must-have", "Back end"]) => {
      const rows = [ROWS[0]!, ROWS[1]!, task("hooks", { parentId: "x", position: "a1", userStart: "2026-10-12", duration: 2, tags })];
      const app = await panelBoard(rows, user);
      const tagRequests = vi.fn(() => ({ body: { tags: known } }));
      app.api.on("GET /api/tags", tagRequests);
      await selectRow(app.user, "hooks");
      return { ...app, tagRequests };
    };
    const tagSection = () => within(panel()).getByRole("heading", { name: "Tags" }).closest("section")!;
    const tagInput = () => within(tagSection()).getByRole("combobox", { name: "Add tag" });
    const chips = () => within(tagSection()).queryAllByRole("listitem").map((item) => item.querySelector("[data-tag]")!.textContent);
    const lastSetTags = () => sentCommands().filter((command) => command.type === "setTags").at(-1);

    it("sits above Links and Interruptions: a borderless Add tag until focused", async () => {
      const { user } = await tagsBoard();
      const headings = within(panel()).getAllByRole("heading").map((heading) => heading.textContent);
      expect(headings.indexOf("Tags")).toBeLessThan(headings.indexOf("Links"));
      expect(headings.indexOf("Interruptions")).toBe(headings.indexOf("Links") - 1);
      expect(chips()).toEqual([]);
      expect(tagInput()).toHaveAttribute("placeholder", "Add tag");
      expect(tagInput().className).toContain("border-transparent");
      expect(tagInput().className).toContain("focus:border-border-strong");
    });

    const offered = async () => (await within(tagSection()).findAllByRole("option")).map((option) => option.textContent);

    it("clicking the box offers the most used tags at once, without the task's own, none highlighted", async () => {
      const { user } = await tagsBoard(["UI"]);
      expect(within(tagSection()).queryByRole("listbox")).not.toBeInTheDocument();
      await user.click(tagInput());
      expect(await offered()).toEqual(["UX research", "Q4 · must-have", "Back end"]);
      for (const option of within(tagSection()).getAllByRole("option")) expect(option).toHaveAttribute("aria-selected", "false");
      expect(tagInput()).not.toHaveAttribute("aria-activedescendant");
      expect(within(tagSection()).getByRole("listbox").className).toContain("fixed");
    });

    it("offers at most 8 with nothing typed; typing finds the rest", async () => {
      const known = Array.from({ length: 10 }, (_, index) => `tag ${index}`);
      const { user } = await tagsBoard([], ADMIN, known);
      await user.click(tagInput());
      expect(await offered()).toEqual(known.slice(0, 8));
      await user.keyboard("tag 9");
      expect(await offered()).toEqual(["tag 9"]);
    });

    it("Enter on the empty box adds nothing; ↓ goes into the list, and the list stays open with what's left", async () => {
      const { user } = await tagsBoard();
      await user.click(tagInput());
      await offered();
      await user.keyboard("{Enter}");
      expect(lastSetTags()).toBeUndefined();
      await user.keyboard("{ArrowDown}");
      expect(within(tagSection()).getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
      await user.keyboard("{Enter}");
      expect(lastSetTags()).toEqual({ type: "setTags", id: "hooks", tags: ["UI"] });
      expect(await offered()).toEqual(["UX research", "Q4 · must-have", "Back end"]);
      for (const option of within(tagSection()).getAllByRole("option")) expect(option).toHaveAttribute("aria-selected", "false");
    });

    it("↑ from nothing highlighted goes to the end of the list", async () => {
      const { user } = await tagsBoard();
      await user.click(tagInput());
      await offered();
      await user.keyboard("{ArrowUp}");
      expect(within(tagSection()).getAllByRole("option").at(-1)).toHaveAttribute("aria-selected", "true");
    });

    it("clicking a suggestion adds it and keeps offering the rest, the focus in the box", async () => {
      const { user } = await tagsBoard();
      await user.click(tagInput());
      await offered();
      await user.click(within(tagSection()).getByRole("option", { name: "UX research" }));
      expect(lastSetTags()).toEqual({ type: "setTags", id: "hooks", tags: ["UX research"] });
      expect(tagInput()).toHaveFocus();
      expect(await offered()).toEqual(["UI", "Q4 · must-have", "Back end"]);
    });

    it("Escape closes the list, keeping what's typed; the box or ↓ opens it again; a second Escape clears the box", async () => {
      const { user } = await tagsBoard();
      await user.click(tagInput());
      await user.keyboard("u");
      await offered();
      await user.keyboard("{Escape}");
      expect(within(tagSection()).queryByRole("listbox")).not.toBeInTheDocument();
      expect(tagInput()).toHaveValue("u");
      expect(tagInput()).toHaveFocus();
      await user.keyboard("{ArrowDown}");
      expect(await offered()).toContain("UI");
      await user.keyboard("{Escape}");
      await user.click(tagInput());
      expect(await offered()).toContain("UI");
      await user.keyboard("{Escape}{Escape}");
      expect(tagInput()).toHaveValue("");
      expect(within(tagSection()).queryByRole("listbox")).not.toBeInTheDocument();
      expect(panel()).toBeInTheDocument();
    });

    it("Enter with the list closed adds what's typed, not a match nobody can see", async () => {
      const { user } = await tagsBoard();
      await user.click(tagInput());
      await user.keyboard("u");
      await offered();
      await user.keyboard("{Escape}{Enter}");
      expect(lastSetTags()).toEqual({ type: "setTags", id: "hooks", tags: ["u"] });
    });

    it("offers nothing until something's typed when no tag exists yet", async () => {
      const { user } = await tagsBoard([], ADMIN, []);
      await user.click(tagInput());
      await waitFor(() => expect(tagInput()).toHaveFocus());
      expect(within(tagSection()).queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("ranks the tags on the board by use too, for who can't list the workspace's", async () => {
      const rows = [
        ROWS[0]!,
        task("a", { parentId: "x", position: "a2", userStart: "2026-10-12", duration: 2, tags: ["Rare"] }),
        task("b", { parentId: "x", position: "a3", userStart: "2026-10-12", duration: 2, tags: ["Common"] }),
        task("c", { parentId: "x", position: "a4", userStart: "2026-10-12", duration: 2, tags: ["Common"] }),
        task("hooks", { parentId: "x", position: "a5", userStart: "2026-10-12", duration: 2 }),
      ];
      const app = await panelBoard(rows, ADMIN);
      app.api.on("GET /api/tags", () => ({ body: { tags: [] } }));
      await selectRow(app.user, "hooks");
      await app.user.click(tagInput());
      expect(await offered()).toEqual(["Common", "Rare"]);
    });

    describe("placing the list", () => {
      const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });
      const place = (boxLeft: number, boxTop: number, listHeight = 100) => {
        const box = document.createElement("input");
        const list = document.createElement("ul");
        box.getBoundingClientRect = () => rect(boxLeft, boxTop, 200, 24);
        // Placed at 0,0 it shows up at 10,20: whatever holds it may be its frame instead of the window.
        list.getBoundingClientRect = () => rect(10, 20, 224, listHeight);
        placeSuggestions(box, list);
        return list.style;
      };

      it("goes under the box, wherever the list's frame is", () => {
        expect(place(100, 200)).toMatchObject({ left: "90px", top: "208px" });
      });

      it("goes above the box when there's no room below", () => {
        expect(place(100, 700)).toMatchObject({ left: "90px", top: "576px" });
      });

      it("stays inside the window on the right", () => {
        expect(place(900, 200).left).toBe("782px");
      });

      it("scrolls rather than leaving the window when neither side has room", () => {
        const style = place(100, 100, 500);
        expect(style.maxHeight).toBe("288px");
        expect(style.top).toBe("108px");
      });
    });

    it('typing lists the matching workspace tags, then + Create "…"', async () => {
      const { user } = await tagsBoard();
      await user.type(tagInput(), "u");
      const options = await within(tagSection()).findAllByRole("option");
      expect(options.map((option) => option.textContent)).toEqual(["UI", "UX research", "Q4 · must-have", '+ Create "u"']);
      expect(options[0]).toHaveAttribute("aria-selected", "true");
    });

    it("Enter adds the highlighted tag, in the workspace's spelling", async () => {
      const { user } = await tagsBoard(["Docs"]);
      await user.type(tagInput(), "ui");
      expect((await within(tagSection()).findAllByRole("option")).map((option) => option.textContent)).toEqual(["UI"]);
      await user.keyboard("{Enter}");
      expect(lastSetTags()).toEqual({ type: "setTags", id: "hooks", tags: ["Docs", "UI"] });
      expect(tagInput()).toHaveValue("");
    });

    it("creates a new tag, and the arrow keys move the highlight", async () => {
      const { user } = await tagsBoard();
      await user.type(tagInput(), "back");
      await within(tagSection()).findAllByRole("option");
      await user.keyboard("{ArrowDown}{Enter}");
      expect(lastSetTags()).toEqual({ type: "setTags", id: "hooks", tags: ["back"] });
    });

    it("× and Backspace in the empty input remove tags", async () => {
      const { user } = await tagsBoard(["UI", "Docs", "Back end"]);
      expect(chips()).toEqual(["UI", "Docs", "Back end"]);
      await user.click(within(tagSection()).getByRole("button", { name: "Remove the tag “Docs”" }));
      expect(lastSetTags()).toEqual({ type: "setTags", id: "hooks", tags: ["UI", "Back end"] });
      await user.click(tagInput());
      await user.keyboard("{Backspace}");
      expect(lastSetTags()).toEqual({ type: "setTags", id: "hooks", tags: ["UI"] });
    });

    it("reorders the chips by dragging their handle", async () => {
      await tagsBoard(["UI", "Docs", "Back end"]);
      within(tagSection())
        .getAllByRole("listitem")
        .forEach((item, index) => {
          item.getBoundingClientRect = () => ({ top: 0, bottom: 20, left: index * 60, right: index * 60 + 50, width: 50, height: 20, x: index * 60, y: 0, toJSON: () => ({}) });
        });
      fireEvent.pointerDown(within(tagSection()).getByRole("button", { name: "Move the tag “UI”" }), { button: 0, clientX: 5, clientY: 10 });
      fireEvent.pointerMove(window, { clientX: 100, clientY: 10 });
      fireEvent.pointerMove(window, { clientX: 170, clientY: 10 });
      fireEvent.pointerUp(window, { clientX: 170, clientY: 10 });
      expect(lastSetTags()).toEqual({ type: "setTags", id: "hooks", tags: ["Docs", "Back end", "UI"] });
    });

    it("viewers see the chips only, and don't fetch the workspace's tags", async () => {
      const { tagRequests } = await tagsBoard(["UI", "Docs"], VIEWER);
      expect(chips()).toEqual(["UI", "Docs"]);
      expect(within(tagSection()).queryByRole("combobox")).not.toBeInTheDocument();
      expect(within(tagSection()).queryByRole("button")).not.toBeInTheDocument();
      expect(tagRequests).not.toHaveBeenCalled();
    });

    it("keeps the typed text when a task is at the tag limit, and says why", async () => {
      const full = Array.from({ length: 50 }, (_, index) => `tag ${index}`);
      const { user } = await tagsBoard(full);
      await user.type(tagInput(), "one more{Enter}");
      expect(await screen.findByText("A task has at most 50 tags")).toBeInTheDocument();
      expect(tagInput()).toHaveValue("one more");
      expect(sentCommands().filter((command) => command.type === "setTags")).toEqual([]);
    });

    it("sections have no Tags section", async () => {
      const { user } = await panelBoard();
      await user.dblClick(rowOf("x").querySelector('[aria-label^="Row "]')!);
      await screen.findByRole("complementary", { name: /^Details of/ });
      expect(within(panel()).queryByRole("heading", { name: "Tags" })).not.toBeInTheDocument();
    });
  });

  it("offers Add a subtask, and for a section Add a task, unless the board is filtered", async () => {
    const { user } = await panelBoard();
    await selectRow(user, "hooks");
    expect(within(panel()).getByRole("button", { name: "Add a subtask" })).toBeInTheDocument();
  });

  it("offers no Add a subtask / Add a task while filtering", async () => {
    const { user } = await panelBoard(ROWS, ADMIN, [], [], "?q=hooks");
    await selectRow(user, "hooks");
    expect(within(panel()).queryByRole("button", { name: /^Add a/ })).not.toBeInTheDocument();
  });

  it("offers no Add a task on a section while filtering", async () => {
    const { user } = await panelBoard(ROWS, ADMIN, [], [], "?q=hooks");
    await user.dblClick(rowOf("x").querySelector('[aria-label^="Row "]')!);
    await screen.findByRole("complementary", { name: /^Details of/ });
    expect(within(panel()).queryByRole("button", { name: /^Add a/ })).not.toBeInTheDocument();
  });

  describe("sections and the More actions menu", () => {
    const openSection = async (user: Awaited<ReturnType<typeof panelBoard>>["user"]) => {
      await user.dblClick(rowOf("x").querySelector('[aria-label^="Row "]')!);
      await screen.findByRole("complementary", { name: /^Details of/ });
    };

    it("a section has a description box that saves with setDescription", async () => {
      const { user } = await panelBoard();
      await openSection(user);
      await user.type(within(panel()).getByRole("textbox", { name: "Description" }), "The first release");
      await user.click(within(panel()).getByRole("textbox", { name: "Task title" })); // leaving saves it
      expect(sentCommands().at(-1)).toEqual({ type: "setDescription", id: "x", description: "The first release" });
    });

    it("a section has Comments, posted against the section", async () => {
      const { api, user } = await panelBoard();
      const posted: unknown[] = [];
      api.on(`POST /api/projects/${PROJECT_ID}/comments`, (body) => {
        posted.push(body);
        return { status: 201, body: { comment: comment("c9", { taskId: "x", body: (body as { body: string }).body, mine: true, author: { userId: ADMIN.id, label: ADMIN.name } }) } };
      });
      await openSection(user);
      expect(within(panel()).getByRole("tab", { name: "Comments" })).toHaveAttribute("aria-selected", "true");
      await user.type(within(panel()).getByRole("textbox", { name: "Write a comment" }), "kick-off monday{Control>}{Enter}{/Control}");
      await waitFor(() => expect(posted).toEqual([{ taskId: "x", body: "kick-off monday" }]));
      expect(await within(panel()).findByText("kick-off monday")).toBeInTheDocument();
    });

    it("has no Delete button at the bottom: it lives in the header's More actions menu", async () => {
      const { user } = await panelBoard();
      await selectRow(user, "hooks");
      expect(within(panel()).queryByRole("button", { name: /^Delete (task|section)$/ })).not.toBeInTheDocument();
      const more = within(panel()).getByRole("button", { name: "More actions" });
      const close = within(panel()).getByRole("button", { name: "Close details (Esc)" });
      expect(more.closest("header")).toBe(close.closest("header"));
      await openSection(user);
      expect(within(panel()).queryByRole("button", { name: /^Delete (task|section)$/ })).not.toBeInTheDocument();
    });

    it("More actions → Delete section deletes the section and closes the panel", async () => {
      const { user } = await panelBoard();
      await openSection(user);
      await user.click(within(panel()).getByRole("button", { name: "More actions" }));
      await user.click(await screen.findByRole("menuitem", { name: "Delete section" }));
      expect(sentCommands().at(-1)).toEqual({ type: "deleteRows", ids: ["x"] });
      expect(await screen.findByText("Deleted “x” and 2 rows inside")).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole("complementary")).not.toBeInTheDocument());
    });

    it("More actions → Delete task deletes the task and closes the panel", async () => {
      const { user } = await panelBoard();
      await selectRow(user, "hooks");
      await user.click(within(panel()).getByRole("button", { name: "More actions" }));
      expect(screen.queryByRole("menuitem", { name: "Delete section" })).not.toBeInTheDocument();
      await user.click(await screen.findByRole("menuitem", { name: "Delete task" }));
      expect(sentCommands().at(-1)).toEqual({ type: "deleteRows", ids: ["hooks"] });
      expect(await screen.findByText("Deleted “hooks”")).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole("complementary")).not.toBeInTheDocument());
    });

    it("viewers get no More actions menu", async () => {
      const { user } = await panelBoard(ROWS, VIEWER);
      await selectRow(user, "hooks");
      expect(within(panel()).queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
    });
  });

  it("is read-only for viewers, who can still comment", async () => {
    const { user } = await panelBoard(ROWS, VIEWER);
    await selectRow(user, "hooks");
    expect(within(panel()).getByRole("textbox", { name: "Task title" })).toBeDisabled();
    expect(within(panel()).queryByRole("button", { name: /^(Add link|Remove link with)/ })).not.toBeInTheDocument();
    expect(within(panel()).queryByRole("button", { name: /^Add a/ })).not.toBeInTheDocument();
    expect(within(panel()).getByRole("textbox", { name: "Write a comment" })).toBeEnabled();
  });
});

describe("rich text (comments and descriptions)", () => {
  it("shows Markdown formatted: bold, italic, lists and safe links", () => {
    const { container } = render(<RichTextView markdown={"**b** *i* see https://x.test/a?b=1 and [docs](https://x.test/docs)\n\n- one\n- two"} />);
    expect(container.querySelector("strong")).toHaveTextContent("b");
    expect(container.querySelector("em")).toHaveTextContent("i");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    const links = [...container.querySelectorAll("a")];
    expect(links.map((link) => link.getAttribute("href"))).toContain("https://x.test/docs");
    for (const link of links) expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
  });

  it("never runs or keeps raw HTML, and refuses javascript: links", () => {
    const { container } = render(<RichTextView markdown={'<img src=x onerror="window.pwned=1"> <script>window.pwned=1</script> [x](javascript:alert(1)) <a href="javascript:alert(2)">y</a>'} />);
    expect(container.querySelector("img, script, iframe")).toBeNull();
    expect(container.querySelector('[onerror], a[href^="javascript"]')).toBeNull();
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });
});

describe("history wording", () => {
  const names = { state: { rows: { p: task("p", { title: "Design" }) }, links: {} }, resources: new Map([[ANA.id, ANA]]) };
  const entry = (name: string, changes: { field: string; before: unknown; after: unknown }[]) => ({
    version: 1,
    commandId: "c",
    name,
    actor: { userId: null, label: "Ana", linkId: null },
    createdAt: "",
    rowIds: ["t"],
    changes: changes.map((change) => ({ rowId: "t", ...change })),
  });
  it("words aiming", () => {
    expect(describeEntry(entry("addBreak", [{ field: "breaks", before: [], after: [{ after: 2, length: 4 }] }]), names, "t")).toBe("added an interruption");
    expect(describeEntry(entry("removeBreak", [{ field: "breaks", before: [{ after: 2, length: 4 }], after: [] }]), names, "t")).toBe("removed an interruption");
    expect(describeEntry(entry("resizeBreak", [{ field: "breaks", before: [{ after: 2, length: 4 }], after: [{ after: 2, length: 2 }] }]), names, "t")).toBe("changed an interruption");
    expect(describeEntry(entry("addInterruption", [{ field: "interruptedBy", before: [], after: ["p"] }]), names, "t")).toBe("made “Design” interrupt it");
    expect(describeEntry(entry("removeInterruption", [{ field: "interruptedBy", before: ["p"], after: [] }]), names, "t")).toBe("stopped “Design” interrupting it");
    expect(describeEntry(entry("setTarget", [{ field: "targetId", before: "gone", after: null }]), names, "t")).toBe("stopped aiming it for a milestone since deleted");
    expect(describeEntry(entry("removeInterruption", [{ field: "interruptedBy", before: ["gone"], after: [] }]), names, "t")).toBe("stopped a task since deleted interrupting it");
    expect(describeEntry(entry("setTarget", [{ field: "targetId", before: null, after: "p" }]), names, "t")).toBe("aimed it for “Design”");
    expect(describeEntry(entry("setTarget", [{ field: "targetId", before: "p", after: null }]), names, "t")).toBe("stopped aiming it for “Design”");
  });

  it("describes changes in words", () => {
    expect(describeEntry(entry("createRow", [{ field: "*", before: null, after: {} }]), names, "t")).toBe("created it");
    expect(describeEntry(entry("indent", [{ field: "parentId", before: null, after: "p" }, { field: "position", before: "a", after: "b" }]), names, "t")).toBe("moved it in the list");
    expect(describeEntry(entry("linkTasks", [{ field: "predecessorId", before: null, after: "p" }]), names, "t")).toBe("made it follow “Design”");
    expect(describeEntry(entry("convertMilestone", [{ field: "duration", before: 3, after: 0 }]), names, "t")).toBe("made it a milestone");
    expect(describeEntry(entry("undo", [{ field: "resourceId", before: ANA.id, after: null }]), names, "t")).toBe("undid a change (unassigned it)");
    // offsets are never shown: a drag that also stored one reads as just the move
    expect(describeEntry(entry("moveTask", [{ field: "userStart", before: "2026-10-01", after: "2026-10-05" }, { field: "offset", before: 0, after: -2 }]), names, "t")).toMatch(/^scheduled it for/);
  });
});
