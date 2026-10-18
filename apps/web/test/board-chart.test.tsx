import type { Command, Link } from "@ganttlines/engine";
import { toDay } from "@ganttlines/engine";
import type { ProjectStateDto } from "@ganttlines/protocol";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

async function chartBoard(rows: ProjectStateDto["rows"] = ROWS, user = ADMIN, links: Link[] = []) {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const api = signedIn(user, [project(PROJECT_ID, "Launch")]);
  api.on(`GET /api/projects/${PROJECT_ID}/state`, () => ({ body: projectState(rows, 5, links) }));
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

  it("links two tasks by dragging the bullet onto the other one", async () => {
    await chartBoard();
    const bullet = within(bar(/^ui,/).parentElement!).getByTitle("Drag onto another task to link them");
    // rows are 30 px tall: hooks is the third row (index 2)
    drag(bullet, 500, 600, 2 * 30 + 15);
    expect(sentCommands()).toEqual([{ type: "addLink", predecessorId: "ui", followerId: "hooks", kind: "FS" }]);
  });

  // hooks spans Oct 12–13: chart x 1344 → 1408 (the chart starts Mon Aug 31; days are 32 px), its middle at 1376.
  const HOOKS_LEFT_HALF = 1350;
  const HOOKS_RIGHT_HALF = 1400;
  const HOOKS_Y = 2 * 30 + 15;
  const startDot = () => within(bar(/^ui,/).parentElement!).getByTitle("Drag from the start onto another task to link them");
  const endDot = () => within(bar(/^ui,/).parentElement!).getByTitle("Drag onto another task to link them");

  it("dragging from the end dot onto the left half of a bar sends FS; onto the right half sends FF", async () => {
    await chartBoard();
    drag(endDot(), 500, HOOKS_LEFT_HALF, HOOKS_Y);
    drag(endDot(), 500, HOOKS_RIGHT_HALF, HOOKS_Y);
    expect(sentCommands()).toEqual([
      { type: "addLink", predecessorId: "ui", followerId: "hooks", kind: "FS" },
      { type: "addLink", predecessorId: "ui", followerId: "hooks", kind: "FF" },
    ]);
  });

  it("dragging from the start dot onto the left half sends SS", async () => {
    await chartBoard();
    drag(startDot(), 500, HOOKS_LEFT_HALF, HOOKS_Y);
    expect(sentCommands()).toEqual([{ type: "addLink", predecessorId: "ui", followerId: "hooks", kind: "SS" }]);
  });

  it("start dot onto a right half sends nothing", async () => {
    await chartBoard();
    const dot = startDot();
    fireEvent.pointerDown(dot, { button: 0, clientX: 500, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: HOOKS_RIGHT_HALF, clientY: HOOKS_Y });
    const hooksStrip = document.querySelector('[data-chart-body] [data-row="2"]')!;
    expect(hooksStrip.className).not.toContain("bg-accent-soft"); // no target highlight
    fireEvent.pointerUp(window, { clientX: HOOKS_RIGHT_HALF, clientY: HOOKS_Y });
    expect(sentCommands()).toEqual([]);
  });

  /** Presses `dot` and moves the pointer to (x, y) without dropping. */
  const hoverLink = (dot: HTMLElement, x: number, y: number) => {
    fireEvent.pointerDown(dot, { button: 0, clientX: 500, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: x, clientY: y });
  };
  const targetMarker = () => document.querySelector('[data-testid="link-target-end"]');
  const kindLabel = () => document.querySelector('[data-testid="link-kind"]');

  it("while linking, marks the end of the target it would tie to and says the kind", async () => {
    await chartBoard();
    hoverLink(endDot(), HOOKS_LEFT_HALF, HOOKS_Y);
    expect(targetMarker()).toHaveAttribute("data-end", "start");
    expect(targetMarker()).toHaveAttribute("cx", "1344");
    expect(kindLabel()).toHaveTextContent("after it finishes");
    fireEvent.pointerMove(window, { clientX: HOOKS_RIGHT_HALF, clientY: HOOKS_Y });
    expect(targetMarker()).toHaveAttribute("data-end", "end");
    expect(targetMarker()).toHaveAttribute("cx", "1408");
    expect(kindLabel()).toHaveTextContent("can't finish before it");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(targetMarker()).toBeNull();
    expect(kindLabel()).toBeNull();
  });

  it("while linking from the start dot onto a right half, shows neither marker nor kind", async () => {
    await chartBoard();
    hoverLink(startDot(), HOOKS_RIGHT_HALF, HOOKS_Y);
    expect(targetMarker()).toBeNull();
    expect(kindLabel()).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
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
    expect(screen.queryByRole("button", { name: /^Options for/ })).not.toBeInTheDocument();
    fireEvent.contextMenu(document.querySelector("[data-chart-body]")!, { clientX: 100, clientY: 5 });
    expect(screen.queryByRole("menuitem", { name: "Highlight this day…" })).not.toBeInTheDocument();
  });
});

describe("linkPath", () => {
  const from = { left: 40, right: 100, y: 15, half: 7 };
  const to = { left: 60, right: 140, y: 45 };

  it("FS is the elbow into the follower's left side", () => {
    expect(linkPath("FS", from, { ...to, left: 140 }, 30)).toBe("M92,22 V45 H140");
  });

  it("linkPath SS/FF snapshots", () => {
    // SS: out of the left edges, round the leftmost, into the follower's left side (pointing right).
    expect(linkPath("SS", from, to, 30)).toBe("M40,15 H32 V45 H60");
    expect(linkPath("SS", { ...from, y: 45 }, { ...to, left: 20, y: 15 }, 30)).toBe("M40,45 H12 V15 H20");
    // FF: out of the right edges, round the rightmost, into the follower's right side (pointing left).
    expect(linkPath("FF", from, to, 30)).toBe("M100,15 H148 V45 H140");
    expect(linkPath("FF", from, { ...to, right: 80 }, 30)).toBe("M100,15 H108 V45 H80");
  });
});
