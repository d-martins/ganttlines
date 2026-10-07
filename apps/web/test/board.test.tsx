import { toDay } from "@ganttlines/engine";
import type { ProjectStateDto } from "@ganttlines/protocol";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatDay } from "../src/board/format";
import { initialBoardView, useBoardView } from "../src/board/view-store";
import { ANA, BASELINE_ID, CALENDAR, FakeWebSocket, PROJECT_ID, projectState, section, task } from "./board-fixtures";
import { ADMIN, project, renderApp, screen, signedIn } from "./utils";

const d = (iso: string) => formatDay(toDay(iso));

/**
 * design (section)            #1
 *   ui     Sep 30 → Oct 8     #2  (Ana: weekend, Oct 5 holiday and her Oct 7 day off are skipped)
 *   hooks  Oct 9 → Oct 12     #3  after ui
 *   review Oct 1, locked      #4  after ui → violation
 * ms       Oct 14 milestone   #5
 * parent   Oct 12 → Oct 14    #6
 *   child                     #7
 */
const ROWS = [
  section("design", { position: "a0" }),
  task("ui", { parentId: "design", position: "a0", userStart: "2026-09-30", duration: 5, resourceId: ANA.id }),
  task("hooks", { parentId: "design", position: "a1", userStart: "2026-10-01", duration: 2, predecessorId: "ui", color: "pink" }),
  task("review", { parentId: "design", position: "a2", userStart: "2026-10-01", duration: 1, predecessorId: "ui", locked: true }),
  task("ms", { position: "b0", userStart: "2026-10-14", duration: 0 }),
  task("parent", { position: "c0" }),
  task("child", { parentId: "parent", position: "a0", userStart: "2026-10-12", duration: 3 }),
];

function openBoard(rows: ProjectStateDto["rows"] = ROWS, path = `/p/${PROJECT_ID}`) {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const api = signedIn(ADMIN, [project(PROJECT_ID, "Launch")]);
  api.on(`GET /api/projects/${PROJECT_ID}/state`, () => ({ body: projectState(rows) }));
  api.on("GET /api/calendar", () => ({ body: CALENDAR }));
  api.on("GET /api/resources", () => ({ body: { resources: [ANA] } }));
  api.on(`GET /api/projects/${PROJECT_ID}/highlights`, () => ({ body: { highlights: [] } }));
  api.on(`GET /api/projects/${PROJECT_ID}/baselines`, () => ({ body: { baselines: [{ id: BASELINE_ID, name: "Kick-off", createdAt: "", createdBy: "Ada" }] } }));
  api.on(`GET /api/projects/${PROJECT_ID}/comment-counts`, () => ({ body: { counts: {} } }));
  api.on(`GET /api/baselines/${BASELINE_ID}`, () => ({
    body: {
      baseline: { id: BASELINE_ID, name: "Kick-off", createdAt: "", createdBy: "Ada" },
      tasks: [
        { rowId: "hooks", kind: "task", title: "hooks", start: "2026-09-30", end: "2026-10-02" },
        { rowId: "33333333-3333-4333-8333-333333333333", kind: "task", title: "retired", start: "2026-10-06", end: "2026-10-07" }, // deleted since
      ],
    },
  }));
  return { api, ...renderApp(path) };
}

/** The board is open and joined at the state's version. */
async function joinedBoard(rows?: ProjectStateDto["rows"], path?: string) {
  const opened = openBoard(rows, path);
  await screen.findByRole("treegrid", { name: "Tasks" });
  await waitFor(() => expect(FakeWebSocket.last.sent).toEqual([{ type: "join", projectId: PROJECT_ID, version: 5 }]));
  FakeWebSocket.last.deliver({ type: "joined", projectId: PROJECT_ID, version: 5, instanceVersion: 1, viewers: [] });
  return opened;
}

const listRow = (title: string) => screen.getAllByRole("row").find((row) => within(row).queryByText(title, { exact: true }))!;
const barWidth = (name: string) => parseFloat(screen.getByLabelText(name).style.width);

describe("board", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 29, 12));
  });
  afterEach(() => vi.useRealTimers());

  it("shows the outline with numbers, durations and predecessors", async () => {
    await joinedBoard();
    expect(within(listRow("hooks")).getByText("3")).toBeInTheDocument();
    expect(within(listRow("hooks")).getByText("#2")).toBeInTheDocument();
    // ui: 5 working days over 9 calendar days
    expect(within(listRow("ui")).getByText("5")).toBeInTheDocument();
    expect(within(listRow("ui")).getByRole("gridcell", { name: "No actual work days" })).toBeInTheDocument();
    expect(within(listRow("ui")).getByText("Ana Silva")).toBeInTheDocument();
  });

  it("names the list's columns for assistive tech, and numbers its rows past the header", async () => {
    await joinedBoard();
    const grid = screen.getByRole("treegrid", { name: "Tasks" });
    expect(within(grid).getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Row number",
      "Task",
      "Assignee",
      "Working days",
      "Actual work days",
      "Predecessor",
      "Actions",
    ]);
    expect(grid).toHaveAttribute("aria-rowcount", String(within(grid).getAllByRole("row").length));
    expect(within(grid).getAllByRole("row")[1]).toHaveAttribute("aria-rowindex", "2"); // the first task, after the header
  });

  it("draws bars, milestones, brackets, sections and dependency arrows", async () => {
    await joinedBoard();
    expect(screen.getByLabelText(`ui, ${d("2026-09-30")} – ${d("2026-10-08")}, Ana Silva`)).toBeInTheDocument();
    expect(screen.getByLabelText(`hooks, ${d("2026-10-09")} – ${d("2026-10-12")}`)).toBeInTheDocument();
    expect(screen.getByLabelText(`ms, ${d("2026-10-14")}`)).toBeInTheDocument();
    expect(screen.getByLabelText(`parent, ${d("2026-10-12")} – ${d("2026-10-14")}`)).toBeInTheDocument();
    expect(screen.getByLabelText(`design, ${d("2026-09-30")} – ${d("2026-10-12")}`)).toBeInTheDocument();
    const arrows = screen.getAllByTestId("dependency");
    expect(arrows).toHaveLength(2);
    expect(arrows.filter((arrow) => arrow.dataset["violation"])).toHaveLength(1);
  });

  it("hides the children of rows collapsed in this browser", async () => {
    localStorage.setItem(`gp.collapsed:${PROJECT_ID}`, JSON.stringify(["parent"]));
    await joinedBoard();
    const list = within(screen.getByRole("treegrid", { name: "Tasks" }));
    expect(list.queryByText("child", { exact: true })).not.toBeInTheDocument();
    expect(list.getByText("hooks", { exact: true })).toBeInTheDocument();
    expect(listRow("parent")).toHaveAttribute("aria-expanded", "false");
    expect(within(listRow("ms")).getByText("5")).toBeInTheDocument();
  });

  it("shows how many comments a task has, and keeps it up to date", async () => {
    const { api } = await joinedBoard();
    expect(within(listRow("hooks")).queryByLabelText(/comments?$/)).not.toBeInTheDocument();
    api.on(`GET /api/projects/${PROJECT_ID}/comment-counts`, () => ({ body: { counts: { hooks: 2 } } }));
    const comment = { id: "c1", taskId: "hooks", author: { userId: null, label: "Rui" }, body: "hi", createdAt: "2026-10-01T10:00:00Z", editedAt: null, deleted: false, mine: false };
    FakeWebSocket.last.deliver({ type: "comment", projectId: PROJECT_ID, comment });
    expect(await within(listRow("hooks")).findByLabelText("2 comments")).toHaveTextContent("2");
  });

  it("forgets collapsed rows that no longer exist", async () => {
    localStorage.setItem(`gp.collapsed:${PROJECT_ID}`, JSON.stringify(["parent", "deleted-long-ago"]));
    await joinedBoard();
    await waitFor(() => expect(JSON.parse(localStorage.getItem(`gp.collapsed:${PROJECT_ID}`)!)).toEqual(["parent"]));
  });

  it("applies live patches and rejoins after a missed one", async () => {
    await joinedBoard();
    const socket = FakeWebSocket.last;
    socket.deliver({
      type: "patch",
      projectId: PROJECT_ID,
      version: 6,
      commandId: "c6",
      actor: { userId: null, label: "Ana" },
      changes: [{ rowId: "hooks", field: "title", before: "hooks", after: "Hooks v2" }],
    });
    await waitFor(() => expect(listRow("Hooks v2")).toBeDefined());
    socket.deliver({ type: "patch", projectId: PROJECT_ID, version: 8, commandId: "c8", actor: { userId: null, label: "Ana" }, changes: [] });
    expect(socket.sent.at(-1)).toEqual({ type: "join", projectId: PROJECT_ID, version: 6 });
  });

  it("switches to roomy bars with the title inside and the full title in a tooltip", async () => {
    const { user } = await joinedBoard();
    await user.click(screen.getByRole("button", { name: "Roomy bars" }));
    const bar = screen.getByLabelText(`ui, ${d("2026-09-30")} – ${d("2026-10-08")}, Ana Silva`);
    expect(within(bar).getByText("ui")).toBeInTheDocument();
    expect(listRow("ui").style.height).toBe("40px");
    await user.hover(bar);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("ui");
    expect(localStorage.getItem("gp.barStyle")).toBe('"roomy"');
    // "review" is one day wide: too short for its title, which moves to the right of the bar
    const review = screen.getAllByLabelText(/^review,/)[0]!;
    expect(within(review).queryByText("review")).not.toBeInTheDocument();
    expect(within(review.parentElement!).getByText("review")).toBeInTheDocument();
  });

  it("hiding weekends and zooming out shorten bars", async () => {
    const { user } = await joinedBoard();
    const hooks = `hooks, ${d("2026-10-09")} – ${d("2026-10-12")}`;
    expect(barWidth(hooks)).toBe(4 * 32); // Fri, Sat, Sun, Mon
    await user.click(screen.getByRole("button", { name: "Hide weekends" }));
    expect(barWidth(hooks)).toBe(2 * 32);
    await user.click(screen.getByRole("button", { name: "Week" }));
    expect(barWidth(hooks)).toBe(2 * 12);
    expect(screen.getByRole("button", { name: "Show weekends" })).toBeInTheDocument();
  });

  it("zooms a step at a time, with presets and with Ctrl + the scroll wheel, and remembers it", async () => {
    const { user } = await joinedBoard();
    const hooks = `hooks, ${d("2026-10-09")} – ${d("2026-10-12")}`;
    expect(barWidth(hooks)).toBe(4 * 32);
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(barWidth(hooks)).toBe(4 * 48);
    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(barWidth(hooks)).toBe(4 * 24);
    expect(screen.getByRole("button", { name: "Day" })).toHaveAttribute("aria-pressed", "false"); // between presets
    await user.click(screen.getByRole("button", { name: "Week" }));
    expect(barWidth(hooks)).toBe(4 * 12);
    expect(screen.getByRole("button", { name: "Week" })).toHaveAttribute("aria-pressed", "true");
    const chart = document.querySelector("[data-chart-body]")!;
    fireEvent.wheel(chart, { deltaY: -100, ctrlKey: true });
    expect(barWidth(hooks)).toBe(4 * 16);
    fireEvent.wheel(chart, { deltaY: 100 }); // without Ctrl it just scrolls
    expect(barWidth(hooks)).toBe(4 * 16);
    expect(localStorage.getItem("gp.dayWidth")).toBe("16");
    await user.click(screen.getByRole("button", { name: "Month" })); // 4 px: the narrowest step
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Zoom in" })).not.toBeDisabled();
  });

  it("starts at the zoom chosen before zoom steps existed", async () => {
    localStorage.setItem("gp.zoom", JSON.stringify("week"));
    useBoardView.setState(initialBoardView());
    await joinedBoard();
    expect(barWidth(`hooks, ${d("2026-10-09")} – ${d("2026-10-12")}`)).toBe(4 * 12);
  });

  it("shows each day's weekday letter when days are wide enough", async () => {
    const { user } = await joinedBoard();
    const letters = () => [...document.querySelectorAll("[data-weekday]")].map((cell) => [cell.getAttribute("data-day"), cell.textContent]);
    expect(letters()).toContainEqual([d("2026-10-05"), "M"]);
    expect(letters()).toContainEqual([d("2026-10-10"), "S"]);
    await user.click(screen.getByRole("button", { name: "Week" }));
    expect(letters()).toEqual([]);
  });

  it("overlays a baseline's dates as ghosts", async () => {
    await joinedBoard(ROWS, `/p/${PROJECT_ID}?baseline=${BASELINE_ID}`);
    expect(await screen.findByTestId("baseline-ghost")).toBeInTheDocument();
    expect(screen.getByLabelText(`hooks, ${d("2026-10-09")} – ${d("2026-10-12")}`)).toBeInTheDocument();
  });

  it("switches to a baseline: its dates, read-only, with a way back", async () => {
    const { user, router } = await joinedBoard(ROWS, `/p/${PROJECT_ID}?baseline=${BASELINE_ID}&compare=switch`);
    expect(await screen.findByText(/Viewing baseline/)).toHaveTextContent("Viewing baseline Kick-off (read-only)");
    expect(screen.getByLabelText(`hooks, ${d("2026-09-30")} – ${d("2026-10-02")}`)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^ui,/)).not.toBeInTheDocument();
    // The working days are the baseline's (3, Wed–Fri), not today's plan (2).
    expect(within(listRow("hooks")).getByRole("gridcell", { name: "3 working days" })).toBeInTheDocument();
    // Tasks deleted since the baseline are still shown, as they were.
    expect(within(listRow("retired")).getByText("deleted since")).toBeInTheDocument();
    expect(screen.getByLabelText(`retired, ${d("2026-10-06")} – ${d("2026-10-07")}`)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to the live plan" }));
    expect(router.state.location.search).toEqual({});
  });

  it("sends you to sign in when the session ends while a board loads", async () => {
    const { api, router } = openBoard();
    // The session ends exactly when the board asks for its state: only that answer can reveal it.
    let ended = false;
    const signedOut = { status: 401, body: { error: "unauthorized", message: "Please sign in" } };
    api.on("GET /api/auth/me", () => (ended ? signedOut : { body: { user: ADMIN } }));
    api.on(`GET /api/projects/${PROJECT_ID}/state`, () => ((ended = true), signedOut));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });

  it("explains projects that are gone or off limits", async () => {
    const { api } = openBoard();
    api.on(`GET /api/projects/${PROJECT_ID}/state`, () => ({ status: 404, body: { error: "not_found", message: "Project not found" } }));
    expect(await screen.findByText(/doesn't exist/)).toBeInTheDocument();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("shows who is here and the connection state", async () => {
    await joinedBoard();
    FakeWebSocket.last.deliver({
      type: "presence",
      projectId: PROJECT_ID,
      viewers: [
        { id: "user:u-admin", name: "Ada Admin" },
        { id: "visitor:v1", name: "Sam (anonymous)" },
      ],
    });
    const viewers = screen.getByRole("list", { name: "People viewing this board" });
    expect(within(viewers).getAllByRole("listitem").map((item) => item.getAttribute("aria-label"))).toEqual(["Ada Admin", "Sam (anonymous)"]);
    expect(screen.getByRole("status", { name: "Connection: Live" })).toBeInTheDocument();
    FakeWebSocket.last.drop(1006);
    expect(await screen.findByText(/Reconnecting… changes by others/)).toBeInTheDocument();
  });

  it("sends people to sign in when the server ends their session", async () => {
    const { api, router } = await joinedBoard();
    api.on("GET /api/auth/me", () => ({ status: 401, body: { error: "unauthorized", message: "Sign in" } }));
    FakeWebSocket.last.drop(4001);
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });

  it("keeps highlights up to date from the socket", async () => {
    await joinedBoard(); // `joined` refetches the lists: the broadcast must win over that refetch
    FakeWebSocket.last.deliver({ type: "highlights", projectId: PROJECT_ID, highlights: [{ id: "h", date: "2026-10-02", label: "Demo", color: "#e5892f" }] });
    expect(await screen.findByLabelText(`Highlight ${d("2026-10-02")}: Demo`)).toBeInTheDocument();
  });
});
