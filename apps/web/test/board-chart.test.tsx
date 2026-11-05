import type { Command, Link, TaskRow } from "@ganttlines/engine";
import { toDay } from "@ganttlines/engine";
import type { ProjectStateDto } from "@ganttlines/protocol";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolsLeft } from "../src/board/chart/chart-rows";
import { aimedMilestones } from "../src/board/chart/milestone-lines";
import { isCriticalPathOn, useCriticalPathView } from "../src/board/critical-path-view";
import { LIST_WIDTH, SLIP_COLUMN } from "../src/board/view-store";
import { linkPath } from "../src/board/chart/dependencies";
import { formatDay } from "../src/board/format";
import { useBoardView } from "../src/board/view-store";
import { ANA, CALENDAR, FakeWebSocket, PROJECT_ID, projectState, section, task } from "./board-fixtures";
import { ADMIN, project, renderApp, screen, signedIn, VIEWER } from "./utils";

const d = (iso: string) => formatDay(toDay(iso));

/** ui Wed Sep 30 → Wed Oct 8 (5 days; Oct 5 holiday); hooks Oct 12–13; idea unscheduled; x: section. */
const ROWS = [
  section("x", { position: "a0" }),
  task("ui", { parentId: "x", position: "a0", userStart: "2026-09-30", duration: 5 }),
  task("hooks", { parentId: "x", position: "a1", userStart: "2026-10-12", duration: 2 }),
  task("idea", { parentId: "x", position: "a2", duration: 2 }),
];

async function chartBoard(rows: ProjectStateDto["rows"] = ROWS, user = ADMIN, links: Link[] = [], search = "", join = true) {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const api = signedIn(user, [project(PROJECT_ID, "Launch")]);
  api.on(`GET /api/projects/${PROJECT_ID}/state`, () => ({ body: projectState(rows, 5, links) }));
  api.on("GET /api/calendar", () => ({ body: CALENDAR }));
  api.on("GET /api/resources", () => ({ body: { resources: [ANA] } }));
  api.on(`GET /api/projects/${PROJECT_ID}/highlights`, () => ({ body: { highlights: [] } }));
  api.on(`GET /api/projects/${PROJECT_ID}/baselines`, () => ({ body: { baselines: [] } }));
  const app = renderApp(`/p/${PROJECT_ID}${search}`);
  await screen.findByRole("treegrid", { name: "Tasks" });
  await waitFor(() => expect(FakeWebSocket.last.sent).toHaveLength(1));
  if (join) FakeWebSocket.last.deliver({ type: "joined", projectId: PROJECT_ID, version: 5, instanceVersion: 1, viewers: [] });
  return { api, ...app };
}

const sentCommands = (): Command[] =>
  FakeWebSocket.last.sent.flatMap((message) => ((message as { type: string }).type === "command" ? [(message as { command: Command }).command] : []));
const bar = (name: string | RegExp) => screen.getByRole("button", { name });
/**
 * jsdom has no layout: the chart body sits at x = 0, so clientX is a chart x. Day width is 32 px.
 * The pointer is released past its last reported move: the drop must land where it is released.
 */
function drag(element: Element, fromX: number, toX: number, toY = 0) {
  fireEvent.pointerDown(element, { button: 0, clientX: fromX, clientY: 0 });
  fireEvent.pointerMove(window, { clientX: (fromX + toX) / 2, clientY: toY / 2 });
  fireEvent.pointerUp(window, { clientX: toX, clientY: toY });
}

describe("chart editing", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 29, 12));
  });
  afterEach(() => vi.useRealTimers());

  it("keeps a roomy bar's title in view while the bar starts under the list", async () => {
    useBoardView.getState().setBarStyle("roomy");
    await chartBoard();
    const shape = bar(/^ui,/);
    const content = () => (shape as HTMLElement).style.paddingLeft;
    expect(content()).toBe("6px");
    const scroller = screen.getByTestId("board-scroller");
    scroller.scrollLeft = parseFloat((shape as HTMLElement).style.left) + 40; // the bar's first 40 px are under the list
    fireEvent.scroll(scroller);
    await waitFor(() => expect(content()).toBe("46px"));
    useBoardView.getState().setBarStyle("compact");
  });

  it("keeps a bar's quick tools just past the task list by CSS (sticky) while the bar starts under it", async () => {
    await chartBoard();
    const tools = screen.getByRole("button", { name: "Options for “ui”" }).closest("[data-bar-tools]") as HTMLElement;
    expect(tools.className).toContain("sticky");
    expect(tools.style.left).toBe("calc(var(--list-width) + 4px)");
    // Clear of the bar: its right edge (three 20 px buttons, 4 px apart) 4 px or more left of the bar.
    expect(parseFloat(tools.style.marginLeft) + 68).toBeLessThanOrEqual(parseFloat(bar(/^ui,/).style.left) - 4);
  });

  it("shows sections as dividers across the chart, without dates", async () => {
    await chartBoard();
    expect(screen.queryByLabelText(/^x,/)).not.toBeInTheDocument(); // no summary bar
    expect(document.querySelector("[data-section-band]")).toHaveTextContent("x");
    // Its name sticks to the chart's visible left edge by CSS alone.
    const label = document.querySelector("[data-section-band] span") as HTMLElement;
    expect(label.className).toContain("sticky");
    expect(label.style.left).toBe("calc(var(--list-width) + 8px)");
    const sectionRow = screen.getAllByRole("row").find((row) => within(row).queryByText("x", { exact: true }))!;
    expect(within(sectionRow).queryByRole("button", { name: /Working days/ })).not.toBeInTheDocument();
  });

  it("names holidays in the date header (shown on hover)", async () => {
    await chartBoard();
    const marker = await screen.findByLabelText(/^Holiday .*Oct 5.*: Republic Day$/);
    expect(marker).toHaveAttribute("title", "Republic Day");
  });

  it("moves a bar by dragging it, snapping to half days at day zoom", async () => {
    await chartBoard();
    const hooks = bar(`hooks, ${d("2026-10-12")} – ${d("2026-10-13")}`);
    drag(hooks, 100, 100 + 2 * 32 + 5);
    expect(sentCommands()).toEqual([{ type: "moveTask", id: "hooks", start: "2026-10-14", half: "morning" }]);
    expect(bar(`hooks, ${d("2026-10-14")} – ${d("2026-10-15")}`)).toBeInTheDocument(); // shown at once
  });

  it("resizes from the end handle and ignores a press that doesn't move (a click selects)", async () => {
    await chartBoard();
    const hooks = bar(`hooks, ${d("2026-10-12")} – ${d("2026-10-13")}`);
    const end = within(hooks.parentElement!).getByTitle("Drag to change the end");
    const day = (iso: string) => (toDay(iso) - toDay("2026-08-31")) * 32 + 16; // chart starts Mon Aug 31
    drag(end, day("2026-10-13"), day("2026-10-15"));
    expect(sentCommands()).toEqual([{ type: "resizeTask", id: "hooks", edge: "end", date: "2026-10-15", half: "afternoon" }]);
    fireEvent.pointerDown(bar(/^ui,/), { button: 0, clientX: 10, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 11, clientY: 0 });
    expect(sentCommands()).toHaveLength(1);
    expect(screen.getAllByRole("row").find((row) => within(row).queryByText("ui", { exact: true }))).toHaveAttribute("aria-selected", "true");
  });

  it("cancels a drag with Escape", async () => {
    await chartBoard();
    const hooks = bar(/^hooks,/);
    fireEvent.pointerDown(hooks, { button: 0, clientX: 100, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 300, clientY: 0 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(window, { clientX: 300, clientY: 0 });
    expect(sentCommands()).toEqual([]);
    expect(bar(`hooks, ${d("2026-10-12")} – ${d("2026-10-13")}`)).toBeInTheDocument();
  });

  it("linking two tasks asks which relation, and the target stands out while dragging", async () => {
    await chartBoard();
    const bullet = within(bar(/^ui,/).parentElement!).getByTitle("Drag onto another task to link them");
    // rows are 30 px tall: hooks is the third row (index 2)
    fireEvent.pointerDown(bullet, { button: 0, clientX: 500, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 600, clientY: 2 * 30 + 15 });
    expect(document.querySelector('[data-chart-body] [data-row="2"]')!.className).toContain("bg-accent-soft");
    fireEvent.pointerUp(window, { clientX: 600, clientY: 2 * 30 + 15 });
    expect(await screen.findByRole("menu", { name: "Link ui and hooks" })).toBeInTheDocument();
    expect(sentCommands()).toEqual([]);
  });

  const WITH_API = [...ROWS, task("api", { parentId: "x", position: "a3", userStart: "2026-09-28", duration: 2 })];
  const fs = (predecessorId: string, followerId: string): Link => ({ predecessorId, followerId, kind: "FS", lag: 0 });
  const arrows = () => [...document.querySelectorAll('[data-testid="dependency"]')];

  it("each link draws one arrow; two links into one task draw two", async () => {
    // Two links into hooks, and a second (SS) link between ui and hooks: three arrows.
    await chartBoard(WITH_API, ADMIN, [fs("ui", "hooks"), fs("api", "hooks"), { ...fs("ui", "hooks"), kind: "SS" }]);
    expect(arrows()).toHaveLength(3);
    expect(new Set(arrows().map((arrow) => arrow.getAttribute("d"))).size).toBe(3);
  });

  it("SS arrows point right into the follower's start; FF arrows point left into its end", async () => {
    await chartBoard(ROWS, ADMIN, [{ ...fs("ui", "hooks"), kind: "SS" }, { ...fs("ui", "hooks"), kind: "FF" }]);
    // hooks spans chart x 1344 → 1408; the arrowhead follows the direction of the last segment.
    const lastSegment = (d: string) => {
      const xs = [...d.matchAll(/[MH](-?[\d.]+)/g)].map((match) => Number(match[1]));
      return { from: xs.at(-2)!, to: xs.at(-1)! };
    };
    const [ss, ff] = arrows().map((arrow) => ({ ...lastSegment(arrow.getAttribute("d")!), marker: arrow.getAttribute("marker-end") }));
    expect(ss).toMatchObject({ to: 1344, marker: "url(#dep-arrow)" });
    expect(ss!.to).toBeGreaterThan(ss!.from);
    expect(ff).toMatchObject({ to: 1408, marker: "url(#dep-arrow)" });
    expect(ff!.to).toBeLessThan(ff!.from);
  });

  it("only the violated link's arrow is red", async () => {
    // hooks is locked to Oct 1, before ui (ending Oct 8) finishes; api finishes Sep 29.
    const rows = WITH_API.map((row) => (row.id === "hooks" ? task("hooks", { parentId: "x", position: "a1", userStart: "2026-10-01", duration: 2, locked: true }) : row));
    await chartBoard(rows, ADMIN, [fs("ui", "hooks"), fs("api", "hooks")]);
    const [red, plain] = [arrows().filter((arrow) => arrow.hasAttribute("data-violation")), arrows().filter((arrow) => !arrow.hasAttribute("data-violation"))];
    expect(red).toHaveLength(1);
    expect(plain).toHaveLength(1);
    expect(red[0]).toHaveAttribute("stroke", "var(--violation)");
    expect(plain[0]).toHaveAttribute("stroke", "var(--dependency)");
  });

  it("works from the keyboard: arrows move or resize, Enter opens the options", async () => {
    const { user } = await chartBoard();
    bar(/^hooks,/).focus();
    // Half a day per step at day zoom: Mon morning → Mon afternoon; the end, Wed midday → Wed evening.
    await user.keyboard("{ArrowRight}");
    expect(sentCommands().at(-1)).toEqual({ type: "moveTask", id: "hooks", start: "2026-10-12", half: "afternoon" });
    expect(bar(`hooks, ${d("2026-10-12")} (afternoon) – ${d("2026-10-14")} (morning)`)).toBeInTheDocument();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(sentCommands().at(-1)).toEqual({ type: "resizeTask", id: "hooks", edge: "end", date: "2026-10-14", half: "afternoon" });
    expect(bar(/^hooks,/)).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("menuitem", { name: "Make it a milestone" }));
    expect(sentCommands().at(-1)).toEqual({ type: "convertMilestone", id: "hooks", milestone: true });
  });

  it("sets colors and duplicates from the spanner menu", async () => {
    const { user } = await chartBoard();
    await user.click(screen.getByRole("button", { name: "Options for “ui”" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "green" }));
    expect(sentCommands().at(-1)).toEqual({ type: "setColor", id: "ui", color: "green" });
    await user.click(screen.getByRole("button", { name: "Options for “ui”" }));
    await user.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
    expect(sentCommands().at(-1)).toMatchObject({ type: "duplicateTask", id: "ui" });
  });

  it("schedules an unscheduled task where its empty track is clicked, and adds tasks from the blank row", async () => {
    const { user } = await chartBoard();
    const strips = document.querySelectorAll("[data-chart-body] [data-row]");
    const ideaTrack = [...strips].find((strip) => strip.getAttribute("data-row") === "3")!;
    const day = (iso: string) => (toDay(iso) - toDay("2026-08-31")) * 32 + 16;
    fireEvent.pointerMove(ideaTrack, { clientX: day("2026-10-06") });
    fireEvent.click(ideaTrack);
    expect(sentCommands().at(-1)).toEqual({ type: "moveTask", id: "idea", start: "2026-10-06" });
    const blank = document.querySelector("[data-chart-body] .cursor-copy")!;
    fireEvent.pointerMove(blank, { clientX: day("2026-10-07") });
    fireEvent.click(blank);
    expect(sentCommands().at(-1)).toMatchObject({ type: "createRow", kind: "task", parentId: null, afterId: "x", start: "2026-10-07" });
    expect(await screen.findByRole("textbox", { name: "Title" })).toHaveFocus();
    await user.keyboard("{Escape}");
  });

  it("has no blank row to add a task from while filtering", async () => {
    await chartBoard(ROWS, ADMIN, [], "?q=hooks");
    expect(document.querySelector("[data-chart-body] [data-row]")).not.toBeNull();
    expect(document.querySelector("[data-chart-body] .cursor-copy")).toBeNull();
  });

  it("highlights a day from the right-click menu", async () => {
    const { api, user } = await chartBoard();
    const saved: unknown[] = [];
    api.on(`POST /api/projects/${PROJECT_ID}/highlights`, (body) => {
      saved.push(body);
      return { status: 201, body: { highlight: { id: "h", ...(body as object) } } };
    });
    const day = (iso: string) => (toDay(iso) - toDay("2026-08-31")) * 32 + 16;
    fireEvent.contextMenu(document.querySelector("[data-chart-body]")!, { clientX: day("2026-10-09"), clientY: 5 });
    await user.click(await screen.findByRole("menuitem", { name: "Highlight this day…" }));
    await user.type(screen.getByLabelText("Label (optional)"), "Demo{Enter}");
    await waitFor(() => expect(saved).toEqual([{ date: "2026-10-09", label: "Demo", color: "#e5892f" }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("opens the day menu from the keyboard (Shift+F10 or the menu key on a bar: its first day)", async () => {
    await chartBoard();
    const hooks = bar(/^hooks,/);
    hooks.focus();
    fireEvent.keyDown(hooks, { key: "F10", shiftKey: true });
    expect(await screen.findByRole("menuitem", { name: "Highlight this day…" })).toBeInTheDocument();
    expect(screen.getByText(formatDay(toDay("2026-10-12")))).toBeInTheDocument();
  });

  it("is read-only for viewers: bars are images, no controls, no day menu", async () => {
    await chartBoard(ROWS, VIEWER);
    expect(screen.getByRole("img", { name: /^hooks,/ })).toBeInTheDocument();
    expect(screen.queryByTitle("Drag onto another task to link them")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Drag from the start onto another task to link them")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Options for/ })).not.toBeInTheDocument();
    fireEvent.contextMenu(document.querySelector("[data-chart-body]")!, { clientX: 100, clientY: 5 });
    expect(screen.queryByRole("menuitem", { name: "Highlight this day…" })).not.toBeInTheDocument();
  });
});

describe("tags on the chart", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 29, 12));
  });
  afterEach(() => {
    vi.useRealTimers();
    useBoardView.getState().setBarStyle("compact");
  });

  const TAGGED = [
    section("x", { position: "a0" }),
    task("ui", { parentId: "x", position: "a0", userStart: "2026-09-30", duration: 5, tags: ["UI", "Docs", "Back end"] }),
    task("hooks", { parentId: "x", position: "a1", userStart: "2026-10-12", duration: 2, tags: ["docs"] }),
  ];
  const rowOf = (name: RegExp) => (screen.queryByRole("button", { name }) ?? screen.getByRole("img", { name })).parentElement!;
  const chipsOf = (name: RegExp) => within(rowOf(name)).queryAllByRole("button", { name: /^Filter by the tag/ }).map((chip) => chip.textContent);

  it.each(["compact", "roomy"] as const)("shows the first two tags beside the title, then +X (%s bars)", async (style) => {
    useBoardView.getState().setBarStyle(style);
    await chartBoard(TAGGED);
    expect(chipsOf(/^ui,/)).toEqual(["UI", "Docs"]);
    expect(within(rowOf(/^ui,/)).getByRole("button", { name: "1 more tag" })).toHaveTextContent("+1");
    expect(chipsOf(/^hooks,/)).toEqual(["docs"]);
    expect(within(rowOf(/^hooks,/)).queryByRole("button", { name: /more tag/ })).not.toBeInTheDocument();
  });

  it("hovering +X lists all the task's tags", async () => {
    const { user } = await chartBoard(TAGGED);
    await user.hover(within(rowOf(/^ui,/)).getByRole("button", { name: "1 more tag" }));
    const popover = await screen.findByRole("dialog", { name: "Tags of “ui”" });
    expect(within(popover).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["UI", "Docs", "Back end"]);
  });

  it("clicking a tag toggles it in the filter, and filtered tags look like the filter's chips (viewers too)", async () => {
    const { user, router } = await chartBoard(TAGGED, VIEWER);
    const docs = () => within(rowOf(/^ui,/)).getByRole("button", { name: "Filter by the tag “Docs”" });
    expect(docs()).toHaveAttribute("aria-pressed", "false");
    await user.click(docs());
    await waitFor(() => expect(router.state.location.search).toEqual({ tags: ["Docs"] }));
    expect(docs()).toHaveAttribute("aria-pressed", "true");
    expect(docs().className).toContain("bg-accent-soft");
    // the same tag, spelled differently on another task, is the same filter
    expect(within(rowOf(/^hooks,/)).getByRole("button", { name: "Filter by the tag “docs”" })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(rowOf(/^ui,/)).getByRole("button", { name: "Filter by the tag “UI”" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ tags: ["Docs", "UI"] }));
    await user.click(docs());
    await waitFor(() => expect(router.state.location.search).toEqual({ tags: ["UI"] }));
    expect(docs()).toHaveAttribute("aria-pressed", "false");
    expect(sentCommands()).toEqual([]);
  });

  it("a click in the +X popover filters too", async () => {
    const { user, router } = await chartBoard(TAGGED);
    await user.click(within(rowOf(/^ui,/)).getByRole("button", { name: "1 more tag" }));
    const popover = await screen.findByRole("dialog", { name: "Tags of “ui”" });
    await user.click(within(popover).getByRole("button", { name: "Filter by the tag “Back end”" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ tags: ["Back end"] }));
  });
});

describe("milestones being aimed at", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 29, 12));
  });
  afterEach(() => vi.useRealTimers());

  const AIMED = (fields: Partial<TaskRow> = {}) => [
    section("x", { position: "a0" }),
    task("ui", { parentId: "x", position: "a0", userStart: "2026-10-05", duration: 2, ...fields }),
    task("free", { parentId: "x", position: "a1", userStart: "2026-10-05", duration: 1 }),
    task("cut", { parentId: "x", position: "a2", userStart: "2026-10-14", duration: 0 }),
    task("other", { parentId: "x", position: "a3", userStart: "2026-10-16", duration: 0 }),
    task("undated", { parentId: "x", position: "a4", duration: 0 }),
  ];
  const lines = () => screen.queryAllByTestId("milestone-line");
  const flags = () => screen.queryAllByTestId("milestone-flag").map((flag) => flag.textContent);
  const bar = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}, `) });

  it("a milestone nobody aims for draws no line", async () => {
    await chartBoard(AIMED());
    expect(lines()).toEqual([]);
    expect(flags()).toEqual([]);
  });

  it("one being aimed at draws a line and a flag with its title", async () => {
    await chartBoard(AIMED({ targetId: "cut" }));
    expect(lines()).toHaveLength(1);
    expect(flags()).toEqual(["cut"]);
  });

  it("two tasks aiming at it draw one line", async () => {
    const rows = AIMED({ targetId: "cut" }).map((row) => (row.id === "free" ? { ...row, targetId: "cut" } : row));
    await chartBoard(rows);
    expect(lines()).toHaveLength(1);
  });

  it("an undated one draws none", async () => {
    await chartBoard(AIMED({ targetId: "undated" }));
    expect(lines()).toEqual([]);
  });

  it("a task past its target is outlined, keeping its colour", async () => {
    const rows = AIMED({ targetId: "cut", duration: 10, color: "purple" }).map((row) => (row.id === "free" ? { ...row, color: "purple" as const } : row));
    await chartBoard(rows); // finishes the 16th, milestone the 14th
    const late = bar("ui");
    expect(late).toHaveAttribute("data-slack", "late");
    expect(late.className).toContain("outline");
    expect(late.style.background).toBe(bar("free").style.background);
    expect(bar("free")).not.toHaveAttribute("data-slack");
  });

  it("a task feeding one that's late is too", async () => {
    await chartBoard(
      [
        section("x", { position: "a0" }),
        task("feeder", { parentId: "x", position: "a0", userStart: "2026-10-05", duration: 1 }),
        task("ui", { parentId: "x", position: "a1", userStart: "2026-10-05", duration: 10, targetId: "cut" }),
        task("cut", { parentId: "x", position: "a2", userStart: "2026-10-14", duration: 0 }),
      ],
      ADMIN,
      [{ predecessorId: "feeder", followerId: "ui", kind: "FS", lag: 0 }],
    );
    expect(bar("feeder")).toHaveAttribute("data-slack", "late");
  });

  it("keeps the line when the milestone's section is collapsed", async () => {
    const rows = [
      section("work", { position: "a0" }),
      task("ui", { parentId: "work", position: "a0", userStart: "2026-10-12", duration: 1, targetId: "cut" }),
      section("dates", { position: "a1" }),
      task("cut", { parentId: "dates", position: "a0", userStart: "2026-10-14", duration: 0 }),
    ];
    const { user } = await chartBoard(rows);
    await user.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryByRole("button", { name: /^cut, / })).not.toBeInTheDocument();
    expect(lines()).toHaveLength(1);
    expect(flags()).toEqual(["cut"]);
  });

  it("a hidden milestone far beyond the visible rows keeps its true date", async () => {
    const rows = [
      section("work", { position: "a0" }),
      task("ui", { parentId: "work", position: "a0", userStart: "2026-10-12", duration: 1, targetId: "cut" }),
      section("dates", { position: "a1" }),
      task("cut", { parentId: "dates", position: "a0", userStart: "2027-06-14", duration: 0 }),
    ];
    const { unmount } = await chartBoard(rows);
    const shown = lines()[0]!.style.left;
    unmount();
    await chartBoard(rows, ADMIN, [], `?q=${encodeURIComponent("ui")}`);
    expect(screen.queryByRole("button", { name: /^cut, / })).not.toBeInTheDocument();
    expect(lines()[0]!.style.left).toBe(shown);
  });

  it("works out no dates for lines on a board nobody aims on", () => {
    const schedule = vi.fn(() => null);
    expect(aimedMilestones({ rows: { t: task("t") }, links: {} }, schedule, [])).toEqual([]);
    expect(schedule).not.toHaveBeenCalled();
  });

  it("a miss is outlined even when a locked follower is the tighter limit", async () => {
    const rows = [
      section("x", { position: "a0" }),
      task("ui", { parentId: "x", position: "a0", userStart: "2026-10-12", duration: 3, targetId: "cut" }),
      task("cut", { parentId: "x", position: "a1", userStart: "2026-10-13", duration: 0 }),
      task("held", { parentId: "x", position: "a2", userStart: "2026-10-13", duration: 1, locked: true }),
    ];
    await chartBoard(rows, ADMIN, [{ predecessorId: "ui", followerId: "held", kind: "FS", lag: 0 }]);
    expect(bar("ui")).toHaveAttribute("data-slack", "late");
  });

  it("a board with no targets has no outlines", async () => {
    await chartBoard(AIMED());
    expect(document.querySelector("[data-slack]")).toBeNull();
  });
});

describe("dragging between a task and a milestone", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 29, 12));
  });
  afterEach(() => vi.useRealTimers());

  const PLAN = (fields: Partial<TaskRow> = {}) => [
    section("x", { position: "a0" }),
    task("build", { parentId: "x", position: "a0", userStart: "2026-10-12", duration: 1, ...fields }),
    task("next", { parentId: "x", position: "a1", userStart: "2026-10-12", duration: 1 }),
    task("8.10", { parentId: "x", position: "a2", userStart: "2026-10-20", duration: 0 }),
    task("8.11", { parentId: "x", position: "a3", userStart: "2026-10-27", duration: 0 }),
  ];
  const handle = (name: string) => within(screen.getByRole("button", { name: new RegExp(`^${name.replace(".", "\\.")}, `) }).parentElement!).getByTitle("Drag onto another task to link them");
  const dragTo = (name: string, row: number) => drag(handle(name), 500, 900, row * 30 + 15);
  /** The options, below the menu's Swap. */
  const options = () => screen.getAllByRole("menuitem").slice(1);
  const choices = () => options().map((item) => item.textContent);
  const commands = () => sentCommands().filter((command) => command.type === "addLink" || command.type === "setTarget");
  const LINKS_FROM_BUILD = ["8.10 starts when build starts", "8.10 finishes when build finishes", "8.10 finishes when build starts"];
  const LINKS_INTO_BUILD = ["build starts when 8.10 starts", "build finishes when 8.10 finishes", "build finishes when 8.10 starts"];

  it("from the task: asks, aiming first, and sends nothing yet", async () => {
    await chartBoard(PLAN());
    dragTo("build", 3); // 8.10
    expect(await screen.findByRole("menu", { name: "Link build and 8.10" })).toBeInTheDocument();
    expect(choices()).toEqual(["build aims for 8.10Never moves the milestone", "8.10 starts after build finishesThe milestone moves if build is late", ...LINKS_FROM_BUILD]);
    expect(commands()).toEqual([]);
  });

  it("from the milestone: the same question, the link reading the other way", async () => {
    await chartBoard(PLAN());
    dragTo("8.10", 1); // build
    await screen.findByRole("menu");
    expect(choices()).toEqual(["build aims for 8.10Never moves the milestone", "build starts after 8.10 finishes", ...LINKS_INTO_BUILD]);
  });

  it("Enter takes the first choice: aiming", async () => {
    const { user } = await chartBoard(PLAN());
    dragTo("build", 3);
    await waitFor(() => expect(options()[0]).toHaveFocus());
    await user.keyboard("{Enter}");
    expect(commands()).toEqual([{ type: "setTarget", id: "build", targetId: "8.10" }]);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("aiming works from the milestone's side too", async () => {
    const { user } = await chartBoard(PLAN());
    dragTo("8.10", 1);
    await screen.findByRole("menu");
    await user.click(options()[0]!);
    expect(commands()).toEqual([{ type: "setTarget", id: "build", targetId: "8.10" }]);
  });

  it.each([
    ["from the task", "build", 3, "build", "8.10"],
    ["from the milestone", "8.10", 1, "8.10", "build"],
  ])("the link choice makes the link dragged, %s", async (_name, from, row, predecessorId, followerId) => {
    const { user } = await chartBoard(PLAN());
    dragTo(from, row);
    await screen.findByRole("menu");
    await user.click(options()[1]!);
    expect(commands()).toEqual([expect.objectContaining({ type: "addLink", predecessorId, followerId })]);
  });

  it("says what it replaces when already aiming elsewhere", async () => {
    await chartBoard(PLAN({ targetId: "8.11" }));
    dragTo("build", 3);
    await screen.findByRole("menu");
    expect(choices()[0]).toBe("build aims for 8.10Instead of 8.11");
  });

  it("Escape cancels: nothing is created", async () => {
    const { user } = await chartBoard(PLAN());
    dragTo("build", 3);
    await screen.findByRole("menu");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(commands()).toEqual([]);
  });

  it("two milestones offer the links, and nothing to aim or interrupt", async () => {
    await chartBoard(PLAN());
    dragTo("8.10", 4); // 8.11
    await screen.findByRole("menu");
    expect(choices()).toEqual(["8.11 starts after 8.10 finishes", "8.11 starts when 8.10 starts", "8.11 finishes when 8.10 finishes", "8.11 finishes when 8.10 starts"]);
  });
});

describe("the Critical path button", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 29, 12));
    localStorage.clear();
    // Most of these start from having turned it off; see "its default" for what happens with no choice made.
    useCriticalPathView.setState({ on: { [PROJECT_ID]: false }, defaults: {} });
  });
  afterEach(() => {
    vi.useRealTimers();
    useCriticalPathView.setState({ on: {}, defaults: {} });
  });

  const PLAN = [
    section("x", { position: "a0" }),
    task("tight", { parentId: "x", position: "a0", userStart: "2026-10-12", duration: 2, targetId: "cut" }),
    task("loose", { parentId: "x", position: "a1", userStart: "2026-10-12", duration: 1, targetId: "cut" }),
    task("late", { parentId: "x", position: "a2", userStart: "2026-10-12", duration: 3, targetId: "cut" }),
    task("after", { parentId: "x", position: "a3", userStart: "2026-10-12", duration: 8 }),
    task("cut", { parentId: "x", position: "a4", userStart: "2026-10-13", duration: 0 }),
  ];
  const FEEDS: Link[] = [{ predecessorId: "first", followerId: "tight2", kind: "FS", lag: 0 }];
  const button = () => screen.getByRole("button", { name: "Critical path" });
  const bar = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}, `) });
  const canSlip = (name: string) => within(rowNamed(name)).queryByRole("gridcell", { name: /^Can slip/ });
  const rowNamed = (name: string) => screen.getAllByRole("row").find((row) => within(row).queryByText(name, { exact: true }))!;

  it("off: no column, no zero outlines, no critical links", async () => {
    await chartBoard(PLAN);
    expect(button()).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("Can slip")).not.toBeInTheDocument();
    expect(bar("tight")).not.toHaveAttribute("data-slack");
    expect(document.querySelector("[data-critical]")).toBeNull();
  });

  it("on: the column follows AWD, naming a milestone limit", async () => {
    const { user } = await chartBoard(PLAN);
    await user.click(button());
    expect(button()).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("AWD").nextElementSibling).toHaveTextContent("Can slip");
    expect(screen.getByRole("columnheader", { name: "Can slip" })).toBeInTheDocument();
    expect(canSlip("tight")).toHaveTextContent(/^0 days$/);
    expect(canSlip("loose")).toHaveTextContent(/^1 day$/);
    expect(canSlip("late")).toHaveTextContent(/^−1 day$/);
    expect(canSlip("after")).toHaveTextContent(/^–$/); // connected to nothing
    expect(canSlip("cut")).toHaveTextContent(/^–$/); // a milestone, even with tasks aiming at it
    expect(screen.getByRole("button", { name: /^cut, / })).not.toHaveAttribute("data-slack");
  });

  it("hovering a value highlights its milestone's line and says what limits it", async () => {
    const { user } = await chartBoard(PLAN);
    await user.click(button());
    const line = screen.getByTestId("milestone-line");
    expect(line).not.toHaveAttribute("data-hovered");
    await user.hover(canSlip("tight")!.firstElementChild ?? canSlip("tight")!);
    expect(line).toHaveAttribute("data-hovered", "true");
    expect(screen.getByTestId("milestone-flag")).toHaveAttribute("data-hovered", "true");
    expect((await screen.findByRole("tooltip")).textContent).toBe("Limited by cut");
    await user.unhover(canSlip("tight")!.firstElementChild ?? canSlip("tight")!);
    expect(line).not.toHaveAttribute("data-hovered");
  });

  it("sections have an empty cell, and the value names its limit for screen readers", async () => {
    const { user } = await chartBoard(PLAN);
    await user.click(button());
    expect(within(rowNamed("x")).queryByRole("gridcell", { name: /^Can slip/ })).toBeNull();
    expect(canSlip("tight")).toHaveAccessibleName("Can slip 0 days, limited by cut");
  });

  it("the highlight goes when the value it came from does", async () => {
    const { user } = await chartBoard(PLAN);
    await user.click(button());
    await user.hover(canSlip("tight")!.firstElementChild!);
    expect(screen.getByTestId("milestone-line")).toHaveAttribute("data-hovered", "true");
    fireEvent.click(button()); // the pointer never leaves it: the column just goes
    expect(screen.getByTestId("milestone-line")).not.toHaveAttribute("data-hovered");
  });

  it("says when the end of the board is the limit, without highlighting anything", async () => {
    const rows = [...PLAN, task("linked", { parentId: "x", position: "a5", userStart: "2026-10-12", duration: 1 }), task("onward", { parentId: "x", position: "a6", userStart: "2026-10-12", duration: 1 })];
    const { user } = await chartBoard(rows, ADMIN, [{ predecessorId: "linked", followerId: "onward", kind: "FS", lag: 0 }]);
    await user.click(button());
    await user.hover(canSlip("linked")!.firstElementChild ?? canSlip("linked")!);
    expect((await screen.findByRole("tooltip")).textContent).toBe("Limited by the end of the board");
    expect(screen.getByTestId("milestone-line")).not.toHaveAttribute("data-hovered");
  });

  it("0 days gets the amber outline, below 0 the red, fills unchanged", async () => {
    const { user } = await chartBoard(PLAN);
    const fill = bar("tight").style.background;
    await user.click(button());
    expect(bar("tight")).toHaveAttribute("data-slack", "zero");
    expect(bar("late")).toHaveAttribute("data-slack", "late");
    expect(bar("loose")).not.toHaveAttribute("data-slack");
    expect(bar("tight").style.background).toBe(fill);
  });

  it("links with no room are marked; others aren't", async () => {
    const rows = [
      section("x", { position: "a0" }),
      task("first", { parentId: "x", position: "a0", userStart: "2026-10-05", duration: 1 }),
      task("tight2", { parentId: "x", position: "a1", userStart: "2026-10-05", duration: 1 }),
      task("spare", { parentId: "x", position: "a2", userStart: "2026-10-05", duration: 1 }),
      task("end", { parentId: "x", position: "a3", userStart: "2026-10-05", duration: 5 }),
    ];
    const links: Link[] = [...FEEDS, { predecessorId: "first", followerId: "end", kind: "SS", lag: 0 }, { predecessorId: "spare", followerId: "end", kind: "FF", lag: 0 }];
    const { user } = await chartBoard(rows, ADMIN, links);
    await user.click(button());
    const marked = [...document.querySelectorAll("[data-testid=dependency]")].filter((path) => path.hasAttribute("data-critical"));
    expect(marked).toHaveLength(1);
  });

  it("gives the column its own room, leaving the chosen list width alone", async () => {
    const { user } = await chartBoard(PLAN);
    const listWidth = () => screen.getByRole("treegrid", { name: "Tasks" }).closest<HTMLElement>("[style*=width]")!.style.width;
    expect(listWidth()).toBe(`${LIST_WIDTH.initial}px`);
    await user.click(button());
    expect(listWidth()).toBe(`${LIST_WIDTH.initial + SLIP_COLUMN}px`);
    expect(useBoardView.getState().listWidth).toBe(LIST_WIDTH.initial);
  });

  it("is remembered per project, and sends no command", async () => {
    const { user } = await chartBoard(PLAN);
    const before = sentCommands().length;
    await user.click(button());
    expect(sentCommands()).toHaveLength(before);
    expect(JSON.parse(localStorage.getItem("gp.criticalPath")!)).toEqual({ [PROJECT_ID]: true });
    expect(isCriticalPathOn(PROJECT_ID)).toBe(true);
    expect(isCriticalPathOn("another")).toBe(false);
  });

  it("viewers can use it", async () => {
    const { user } = await chartBoard(PLAN, VIEWER);
    await user.click(button());
    expect(screen.getByRole("columnheader", { name: "Can slip" })).toBeInTheDocument();
  });
});

describe("the Critical path button's default", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 29, 12));
    localStorage.clear();
    useCriticalPathView.setState({ on: {}, defaults: {} });
  });
  afterEach(() => {
    vi.useRealTimers();
    useCriticalPathView.setState({ on: {}, defaults: {} });
  });

  const rows = (aim: boolean) => [
    section("x", { position: "a0" }),
    task("build", { parentId: "x", position: "a0", userStart: "2026-10-12", duration: 1, targetId: aim ? "cut" : null }),
    task("cut", { parentId: "x", position: "a1", userStart: "2026-10-20", duration: 0 }),
  ];
  const button = () => screen.getByRole("button", { name: "Critical path" });
  const handle = (name: string) => within(screen.getByRole("button", { name: new RegExp(`^${name}, `) }).parentElement!).getByTitle("Drag onto another task to link them");

  it("is on when the board has an aim", async () => {
    await chartBoard(rows(true));
    await waitFor(() => expect(button()).toHaveAttribute("aria-pressed", "true"));
  });

  it("settles as soon as the board shows, before the connection is up", async () => {
    await chartBoard(rows(true), ADMIN, [], "", false);
    await waitFor(() => expect(button()).toHaveAttribute("aria-pressed", "true"));
  });

  it("is off when it has none", async () => {
    await chartBoard(rows(false));
    expect(button()).toHaveAttribute("aria-pressed", "false");
  });

  it("a choice made stands, even with aims on the board", async () => {
    useCriticalPathView.setState({ on: { [PROJECT_ID]: false } });
    await chartBoard(rows(true));
    expect(button()).toHaveAttribute("aria-pressed", "false");
  });

  it("turning it off is remembered", async () => {
    const { user } = await chartBoard(rows(true));
    await waitFor(() => expect(button()).toHaveAttribute("aria-pressed", "true"));
    await user.click(button());
    expect(button()).toHaveAttribute("aria-pressed", "false");
    expect(JSON.parse(localStorage.getItem("gp.criticalPath")!)).toEqual({ [PROJECT_ID]: false });
  });

  it("comes back on when you add an aim, even if you'd turned it off", async () => {
    useCriticalPathView.setState({ on: { [PROJECT_ID]: false } });
    const { user } = await chartBoard(rows(false));
    drag(handle("build"), 500, 900, 2 * 30 + 15);
    await user.click((await screen.findAllByRole("menuitem"))[1]!);
    expect(button()).toHaveAttribute("aria-pressed", "true");
  });

  it("stays as it is when you add a plain link", async () => {
    const { user } = await chartBoard(rows(false));
    drag(handle("build"), 500, 900, 2 * 30 + 15);
    await user.click((await screen.findAllByRole("menuitem"))[2]!);
    expect(button()).toHaveAttribute("aria-pressed", "false");
  });

  it("doesn't change when someone else adds an aim", async () => {
    await chartBoard(rows(false));
    act(() => {
      FakeWebSocket.last.deliver({ type: "patch", projectId: PROJECT_ID, version: 6, commandId: "other", actor: { userId: null, label: "Ana" }, changes: [{ rowId: "build", field: "targetId", before: null, after: "cut" }] });
    });
    await waitFor(() => expect(screen.getByTestId("milestone-line")).toBeInTheDocument());
    expect(button()).toHaveAttribute("aria-pressed", "false");
  });
});

describe("tags in the bar's menu", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 29, 12));
  });
  afterEach(() => vi.useRealTimers());

  const TAGGED = [
    section("x", { position: "a0" }),
    task("ui", { parentId: "x", position: "a0", userStart: "2026-09-30", duration: 5, tags: ["UI", "BE"] }),
    task("hooks", { parentId: "x", position: "a1", userStart: "2026-10-12", duration: 2, tags: ["release"] }),
    task("kid", { parentId: "hooks", position: "a0", userStart: "2026-10-12", duration: 2 }),
    task("idle", { parentId: "x", position: "a2", userStart: "2026-10-20", duration: 2, locked: true, tags: ["frozen"] }),
  ];

  async function openMenu(name = "ui") {
    const app = await chartBoard(TAGGED);
    await app.user.click(screen.getByRole("button", { name: `Options for “${name}”` }));
    const menu = await screen.findByRole("menu");
    const input = within(menu).getByRole("combobox", { name: "Add tag" }) as HTMLInputElement;
    return { ...app, menu, input };
  }
  const chips = (menu: HTMLElement) => within(menu).queryAllByRole("listitem").flatMap((item) => item.querySelector("[data-tag]")?.textContent ?? []);
  const setTags = () => sentCommands().filter((command) => command.type === "setTags");

  it("sits under Color, above the actions, and the menu doesn't open into the box", async () => {
    const { menu, input } = await openMenu();
    const labels = within(menu).getAllByText(/^(Color|Tags)$/).map((label) => label.textContent);
    expect(labels).toEqual(["Color", "Tags"]);
    expect(chips(menu)).toEqual(["UI", "BE"]);
    const lock = within(menu).getByRole("menuitem", { name: "Lock dates" });
    expect(input.compareDocumentPosition(lock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(menu).getByText("Tags").className).toBe(within(menu).getByText("Color").className);
    expect(input).not.toHaveFocus();
    expect(input.className).toContain("border-transparent");
  });

  it("shows for a parent too, between single separators", async () => {
    const { menu } = await openMenu("hooks");
    expect(chips(menu)).toEqual(["release"]);
    expect(within(menu).queryByRole("menuitem", { name: "Duplicate" })).not.toBeInTheDocument();
    const separators = within(menu).getAllByRole("separator");
    expect(separators).toHaveLength(2);
    expect(separators[1]!.nextElementSibling).toBe(within(menu).getByRole("menuitem", { name: "Delete" }));
  });

  it("adds what's typed on Enter: one setTags with the full list, and the menu stays open", async () => {
    const { user, menu, input } = await openMenu();
    await user.click(input);
    await user.keyboard("new one{Enter}");
    expect(setTags()).toEqual([{ type: "setTags", id: "ui", tags: ["UI", "BE", "new one"] }]);
    expect(screen.getByRole("menu")).toBe(menu);
    expect(chips(menu)).toEqual(["UI", "BE", "new one"]);
    expect(input).toHaveFocus();
    expect(input).toHaveValue("");
  });

  it("clicking the box offers tags at once, floating over the menu, leaving out the task's own", async () => {
    const { user, menu, input } = await openMenu();
    expect(within(menu).queryByRole("listbox")).not.toBeInTheDocument();
    await user.click(input);
    const list = within(menu).getByRole("listbox", { name: "Tags to add" });
    expect(list.className).toContain("fixed");
    expect(within(list).getAllByRole("option").map((option) => option.textContent)).toEqual(["frozen", "release"]);
    await user.keyboard("{Enter}");
    expect(setTags()).toEqual([]);
    expect(screen.getByRole("menu")).toBe(menu);
  });

  it("Tab into the box offers them too, and Escape closes the list before the menu", async () => {
    const { user, menu } = await openMenu();
    await user.keyboard("{Tab}");
    expect(within(menu).getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(within(menu).queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("menu")).toBe(menu);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("removing a chip with × brings the focus back without opening the list", async () => {
    const { user, menu, input } = await openMenu();
    await user.click(within(menu).getByRole("button", { name: "Remove the tag “UI”" }));
    expect(input).toHaveFocus();
    expect(within(menu).queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("keeps the box focused while typing: no typeahead, no closing on Space", async () => {
    const { user, menu, input } = await openMenu();
    await user.click(input);
    await user.keyboard("lock dates");
    expect(input).toHaveFocus();
    expect(input).toHaveValue("lock dates");
    expect(screen.getByRole("menu")).toBe(menu);
    expect(sentCommands().filter((command) => command.type === "setLocked")).toEqual([]);
  });

  it("arrow keys in the box move through the suggestions, not the menu", async () => {
    const { user, input, menu } = await openMenu();
    await user.click(input);
    await user.keyboard("re");
    const options = within(menu).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["release", '+ Create "re"']);
    await user.keyboard("{ArrowDown}");
    expect(input).toHaveFocus();
    expect(options[1]).toHaveAttribute("aria-selected", "true");
  });

  it("× removes a tag and Backspace in the empty box the last one; the menu stays open", async () => {
    const { user, menu, input } = await openMenu();
    await user.click(within(menu).getByRole("button", { name: "Remove the tag “UI”" }));
    expect(setTags().at(-1)).toEqual({ type: "setTags", id: "ui", tags: ["BE"] });
    expect(screen.getByRole("menu")).toBe(menu);
    expect(input).toHaveFocus(); // not lost with the chip, nor on a swatch
    await user.keyboard("{Backspace}");
    expect(setTags().at(-1)).toEqual({ type: "setTags", id: "ui", tags: [] });
    expect(screen.getByRole("menu")).toBe(menu);
  });

  it("clicking a suggestion adds it and keeps the menu open", async () => {
    const { user, menu, input } = await openMenu();
    await user.click(input);
    await user.keyboard("re");
    const list = within(menu).getByRole("listbox", { name: "Tags to add" });
    await user.click(within(list).getByRole("option", { name: "release" }));
    expect(setTags()).toEqual([{ type: "setTags", id: "ui", tags: ["UI", "BE", "release"] }]);
    expect(screen.getByRole("menu")).toBe(menu);
    expect(input).toHaveFocus();
  });

  it("reorders by dragging a chip's handle, and the menu stays open", async () => {
    const { menu } = await openMenu();
    const handle = within(menu).getByRole("button", { name: "Move the tag “BE”" });
    fireEvent.pointerDown(handle, { button: 0 });
    // jsdom has no layout: every chip is a 0×0 box at the origin, so y = 0, x = -1 is "before the first".
    fireEvent.pointerMove(window, { clientX: -1, clientY: 0 });
    fireEvent.pointerUp(window);
    expect(setTags()).toEqual([{ type: "setTags", id: "ui", tags: ["BE", "UI"] }]);
    expect(screen.getByRole("menu")).toBe(menu);
  });

  it("Escape closes the suggestions only while they show, and the menu otherwise", async () => {
    const { user, menu, input } = await openMenu();
    await user.click(input);
    await user.keyboard("re");
    expect(within(menu).getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("menu")).toBe(menu);
    expect(within(menu).queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).toHaveFocus();
    expect(input).toHaveValue("re");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("Escape closes the menu when what's typed offers nothing", async () => {
    const { user, input } = await openMenu();
    await user.click(input);
    await user.keyboard("UI"); // already on the task
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("arrow keys still walk the swatches and items when the focus isn't in the box", async () => {
    const { user, menu } = await chartBoard(TAGGED).then(async (app) => {
      const trigger = screen.getByRole("button", { name: "Options for “ui”" });
      trigger.focus();
      await app.user.keyboard("{Enter}");
      return { ...app, menu: await screen.findByRole("menu") };
    });
    const swatches = within(menu).getAllByRole("menuitemradio");
    await waitFor(() => expect(swatches[0]).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(swatches[1]).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(swatches[0]).toHaveFocus();
    await user.keyboard("{End}{ArrowUp}");
    expect(within(menu).getByRole("menuitem", { name: "Duplicate" })).toHaveFocus();
    for (let step = 0; step < 3; step++) await user.keyboard("{ArrowUp}");
    expect(swatches.at(-1)).toHaveFocus(); // the arrows pass over the tag box
  });

  it("Tab goes from the menu's items to the box and back", async () => {
    const { user, menu, input } = await openMenu();
    await user.keyboard("{Tab}");
    expect(input).toHaveFocus();
    await user.keyboard("{Tab}");
    expect(input).not.toHaveFocus();
    expect(menu.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toHaveAttribute("role", "menuitemradio");
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(input).toHaveFocus();
    expect(screen.getByRole("menu")).toBe(menu);
  });

  it("the mouse passing over the items leaves the focus in the box", async () => {
    const { user, menu, input } = await openMenu();
    await user.click(input);
    await user.keyboard("re");
    const lock = within(menu).getByRole("menuitem", { name: "Lock dates" });
    await user.hover(lock);
    expect(input).toHaveFocus();
    await user.hover(menu);
    expect(input).toHaveFocus();
    await user.keyboard("d");
    expect(input).toHaveValue("red");
  });

  it("the items take the focus on hover as ever when the box hasn't got it", async () => {
    const { user, menu } = await openMenu();
    const lock = within(menu).getByRole("menuitem", { name: "Lock dates" });
    await user.hover(lock);
    expect(lock).toHaveFocus();
  });

  it("a locked task's tags stay editable", async () => {
    const { user, menu, input } = await openMenu("idle");
    expect(within(menu).getByRole("menuitem", { name: "Unlock dates" })).toBeInTheDocument();
    await user.click(input);
    await user.keyboard("thaw{Enter}");
    expect(setTags()).toEqual([{ type: "setTags", id: "idle", tags: ["frozen", "thaw"] }]);
  });

  it("the items still work after typing", async () => {
    const { user, menu, input } = await openMenu();
    await user.click(input);
    await user.keyboard("half a tag");
    await user.click(within(menu).getByRole("menuitem", { name: "Duplicate" }));
    expect(sentCommands().at(-1)).toMatchObject({ type: "duplicateTask", id: "ui" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  describe("with a tag filter on", () => {
    const filtered = (tags = ["UI"]) => `?tags=${encodeURIComponent(JSON.stringify(tags))}`;
    const uiOptions = () => screen.queryByRole("button", { name: "Options for “ui”", hidden: true });

    async function openFiltered() {
      const app = await chartBoard(TAGGED, ADMIN, [], filtered());
      await app.user.click(uiOptions()!);
      return { ...app, menu: await screen.findByRole("menu") };
    }

    it("removing the filtered tag keeps the menu and the row, and focus stays in the menu", async () => {
      const { user, menu } = await openFiltered();
      await user.click(within(menu).getByRole("button", { name: "Remove the tag “UI”" }));
      expect(setTags()).toEqual([{ type: "setTags", id: "ui", tags: ["BE"] }]);
      expect(screen.getByRole("menu")).toBe(menu);
      expect(uiOptions()).toBeInTheDocument();
      expect(within(menu).getByRole("combobox", { name: "Add tag" })).toHaveFocus();
    });

    it("the row leaves 5 s after the menu closes and another row is selected", async () => {
      const { user, menu } = await openFiltered();
      await user.click(within(menu).getByRole("button", { name: "Remove the tag “UI”" }));
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
      expect(uiOptions()).toBeInTheDocument();
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      fireEvent.click(document.querySelector('[data-chart-body] [data-row="0"]')!); // the section above it
      act(() => void vi.advanceTimersByTime(4999));
      expect(uiOptions()).toBeInTheDocument();
      act(() => void vi.advanceTimersByTime(1));
      expect(uiOptions()).not.toBeInTheDocument();
    });

    it("a row that goes away takes its menu with it: bringing the row back doesn't reopen it", async () => {
      const { router } = await openFiltered();
      await act(() => router.navigate({ to: ".", search: { tags: ["release"] } as never }));
      await waitFor(() => expect(uiOptions()).not.toBeInTheDocument());
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      await act(() => router.navigate({ to: ".", search: {} as never }));
      await waitFor(() => expect(uiOptions()).toBeInTheDocument());
      await act(async () => {});
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
  });

  describe("the day menu under the chart", () => {
    const dayMenuItem = () => screen.queryByRole("menuitem", { name: "Highlight this day…", hidden: true });

    it("a right-click in the tag box leaves the browser's own menu alone", async () => {
      const { input } = await openMenu();
      expect(fireEvent.contextMenu(input, { clientX: 100, clientY: 5 })).toBe(true); // true: not default-prevented
      await act(async () => {});
      expect(dayMenuItem()).not.toBeInTheDocument();
    });

    it("a touch long-press in the tag box doesn't open it", async () => {
      const { input } = await openMenu();
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      fireEvent.pointerDown(input, { pointerType: "touch", button: 0, clientX: 100, clientY: 5 });
      act(() => void vi.advanceTimersByTime(800));
      expect(dayMenuItem()).not.toBeInTheDocument();
    });

    it("opens again once the menu has closed", async () => {
      const { user } = await openMenu();
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
      fireEvent.contextMenu(document.querySelector("[data-chart-body]")!, { clientX: 100, clientY: 5 });
      expect(await screen.findByRole("menuitem", { name: "Highlight this day…" })).toBeInTheDocument();
    });
  });
});

describe("toolsLeft", () => {
  it("puts a bar's quick tools left of its start dot, 4 px clear, or past its end dot when the chart's edge leaves no room", () => {
    expect(toolsLeft({ left: 200, right: 300 })).toBe(112); // tools 112–180, start dot 186–196
    expect(toolsLeft({ left: 86, right: 300 })).toBe(0); // just fits: tools 0–68, start dot 72–82
    expect(toolsLeft({ left: 62, right: 100 })).toBe(118); // end dot 104–114, tools from 118
  });
});

describe("linkPath", () => {
  const from = { left: 40, right: 100, y: 15, half: 7 };
  const to = { left: 60, right: 140, y: 45 };

  it("FS is the elbow into the follower's left side", () => {
    expect(linkPath("FS", from, { ...to, left: 140 }, 30)).toBe("M92,22 V45 H140");
  });

  it("linkPath SS/FF snapshots", () => {
    // SS: out of the predecessor's left edge (the bar itself, so the line never looks detached; the
    // start dot covers it on hover), round the leftmost, into the follower's left side (pointing right).
    expect(linkPath("SS", from, to, 30)).toBe("M40,15 H32 V45 H60");
    expect(linkPath("SS", { ...from, y: 45 }, { ...to, left: 20, y: 15 }, 30)).toBe("M40,45 H12 V15 H20");
    expect(linkPath("SS", from, to, 30).startsWith(`M${from.left},${from.y} `)).toBe(true);
    // FF: out of the right edges, round the rightmost, into the follower's right side (pointing left).
    expect(linkPath("FF", from, to, 30)).toBe("M100,15 H148 V45 H140");
    expect(linkPath("FF", from, { ...to, right: 80 }, 30)).toBe("M100,15 H108 V45 H80");
  });

  it("SF arrow path", () => {
    // Out of the predecessor's left edge, between the rows, round the follower's end, into it (pointing left).
    expect(linkPath("SF", from, to, 30)).toBe("M40,15 H32 V30 H148 V45 H140");
    expect(linkPath("SF", { ...from, y: 45 }, { ...to, y: 15 }, 30)).toBe("M40,45 H32 V30 H148 V15 H140");
    // A follower ending well before the predecessor starts: straight across into its end.
    expect(linkPath("SF", from, { ...to, left: 0, right: 20 }, 30)).toBe("M40,15 H32 V45 H20");
  });
});
