import type { Command } from "@ganttlines/engine";
import type { CommentDto, ProjectStateDto } from "@ganttlines/protocol";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeEntry } from "../src/board/panel/activity";
import { RichTextView } from "../src/ui/rich-text";
import { ANA, CALENDAR, FakeWebSocket, PROJECT_ID, projectState, section, task } from "./board-fixtures";
import { ADMIN, project, renderApp, screen, signedIn, VIEWER } from "./utils";

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

async function panelBoard(rows: ProjectStateDto["rows"] = ROWS, user = ADMIN, comments: CommentDto[] = [], links: ProjectStateDto["links"] = []) {
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
  const app = renderApp(`/p/${PROJECT_ID}`);
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
    expect(within(when).getAllByRole("option").map((option) => option.textContent)).toEqual(["starts before", "starts after", "ends before", "ends after"]);
    expect(within(ui!).getByRole("button", { name: "Link with #2 ui: change the task" })).toHaveTextContent("#2 ui");
    const end = within(ui!).getByRole("combobox", { name: "Link with #2 ui: the other task" });
    expect(end).toHaveDisplayValue("finished");
    expect(within(end).getAllByRole("option").map((option) => option.textContent)).toEqual(["finished", "started"]);
    expect(within(ui!).getByRole("button", { name: "Remove link with #2 ui" })).toBeInTheDocument();
    expect(within(qa!).getByRole("combobox", { name: "Link with #4 qa: this task" })).toHaveDisplayValue("starts before");
    expect(within(qa!).getByRole("combobox", { name: "Link with #4 qa: the other task" })).toHaveDisplayValue("started");
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
      { type: "removeLink", predecessorId: "ui", followerId: "hooks", kind: "FS", keepPlace: false },
      { type: "addLink", predecessorId: "docs", followerId: "hooks", kind: "FS" },
    ]);
    await waitFor(() => expect(within(panel()).getByRole("button", { name: "Link with #5 docs: change the task" })).toHaveFocus());
    expect(within(panel()).queryByRole("button", { name: /^Link with #2 ui/ })).not.toBeInTheDocument();
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
