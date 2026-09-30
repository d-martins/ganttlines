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

async function panelBoard(rows: ProjectStateDto["rows"] = ROWS, user = ADMIN, comments: CommentDto[] = []) {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const api = signedIn(user, [project(PROJECT_ID, "Launch")]);
  api.on(`GET /api/projects/${PROJECT_ID}/state`, () => ({ body: projectState(rows) }));
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
/** Selects a row by clicking its number in the list (which opens the panel). */
const selectRow = async (user: ReturnType<typeof import("@testing-library/user-event").default.setup>, title: string) => {
  const row = screen.getAllByRole("row").find((candidate) => within(candidate).queryByText(title, { exact: true }))!;
  await user.click(row.querySelector('[aria-label^="Row "]')!);
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
    await user.click(within(panel()).getByRole("button", { name: "Predecessor: None" }));
    await user.type(screen.getByRole("combobox", { name: "Find a predecessor" }), "ui{Enter}");
    expect(sentCommands().at(-1)).toEqual({ type: "linkTasks", fromId: "ui", toId: "hooks" });
    expect(within(panel()).queryByRole("spinbutton", { name: /offset/i })).not.toBeInTheDocument();
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

  it("scrolls a row's bar into view (start just inside the left edge) when its already selected row is clicked again", async () => {
    const { user } = await panelBoard();
    const scrollTo = vi.fn();
    const scroller = screen.getByTestId("board-scroller");
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo;
    await selectRow(user, "hooks");
    expect(scrollTo).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Working days of “hooks”" })); // opens the cell, doesn't center
    await user.keyboard("{Escape}");
    expect(scrollTo).not.toHaveBeenCalled();
    await selectRow(user, "hooks");
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
    expect(await within(panel()).findByText(/assigned it to Ana Silva/)).toBeInTheDocument();
    expect(within(panel()).getByText("via share link")).toBeInTheDocument();
  });

  it("is read-only for viewers, who can still comment", async () => {
    const { user } = await panelBoard(ROWS, VIEWER);
    await selectRow(user, "hooks");
    expect(within(panel()).getByRole("textbox", { name: "Task title" })).toBeDisabled();
    expect(within(panel()).queryByRole("button", { name: /^Predecessor/ })).not.toBeInTheDocument(); // shown as text
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
  const names = { state: { rows: { p: task("p", { title: "Design" }) } }, resources: new Map([[ANA.id, ANA]]) };
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
    expect(describeEntry(entry("createRow", [{ field: "*", before: null, after: {} }]), names)).toBe("created it");
    expect(describeEntry(entry("indent", [{ field: "parentId", before: null, after: "p" }, { field: "position", before: "a", after: "b" }]), names)).toBe("moved it in the list");
    expect(describeEntry(entry("linkTasks", [{ field: "predecessorId", before: null, after: "p" }]), names)).toBe("made it follow “Design”");
    expect(describeEntry(entry("convertMilestone", [{ field: "duration", before: 3, after: 0 }]), names)).toBe("made it a milestone");
    expect(describeEntry(entry("undo", [{ field: "resourceId", before: ANA.id, after: null }]), names)).toBe("undid a change (unassigned it)");
    // offsets are never shown: a drag that also stored one reads as just the move
    expect(describeEntry(entry("moveTask", [{ field: "userStart", before: "2026-10-01", after: "2026-10-05" }, { field: "offset", before: 0, after: -2 }]), names)).toMatch(/^scheduled it for/);
  });
});
