import { toDay } from "@ganttlines/engine";
import type { ProjectStateDto } from "@ganttlines/protocol";
import { waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatDay } from "../src/board/format";
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
  api.on(`GET /api/baselines/${BASELINE_ID}`, () => ({
    body: {
      baseline: { id: BASELINE_ID, name: "Kick-off", createdAt: "", createdBy: "Ada" },
      tasks: [{ rowId: "hooks", kind: "task", title: "hooks", start: "2026-10-01", end: "2026-10-02" }],
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
const barWidth = (name: string) => parseFloat(screen.getByRole("img", { name }).style.width);

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
    expect(within(listRow("ui")).getByText("9")).toBeInTheDocument();
    expect(within(listRow("ui")).getByText("Ana Silva")).toBeInTheDocument();
  });

  it("draws bars, milestones, brackets, sections and dependency arrows", async () => {
    await joinedBoard();
    expect(screen.getByRole("img", { name: `ui, ${d("2026-09-30")} – ${d("2026-10-08")}, Ana Silva` })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: `hooks, ${d("2026-10-09")} – ${d("2026-10-12")}` })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: `ms, ${d("2026-10-14")}` })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: `parent, ${d("2026-10-12")} – ${d("2026-10-14")}` })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: `design, ${d("2026-09-30")} – ${d("2026-10-12")}` })).toBeInTheDocument();
    const arrows = screen.getAllByTestId("dependency");
    expect(arrows).toHaveLength(2);
    expect(arrows.filter((arrow) => arrow.dataset["violation"])).toHaveLength(1);
  });

  it("hides the children of rows collapsed in this browser", async () => {
    localStorage.setItem(`gp.collapsed:${PROJECT_ID}`, JSON.stringify(["parent"]));
    // A collapsed flag stored on the server has no effect: collapsing is a per-browser view.
    await joinedBoard(ROWS.map((row) => (row.id === "design" ? { ...row, collapsed: true } : row)));
    const list = within(screen.getByRole("treegrid", { name: "Tasks" }));
    expect(list.queryByText("child", { exact: true })).not.toBeInTheDocument();
    expect(list.getByText("hooks", { exact: true })).toBeInTheDocument();
    expect(listRow("parent")).toHaveAttribute("aria-expanded", "false");
    expect(within(listRow("ms")).getByText("5")).toBeInTheDocument();
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
    const bar = screen.getByRole("img", { name: `ui, ${d("2026-09-30")} – ${d("2026-10-08")}, Ana Silva` });
    expect(within(bar).getByText("ui")).toBeInTheDocument();
    expect(listRow("ui").style.height).toBe("40px");
    await user.hover(bar);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("ui");
    expect(localStorage.getItem("gp.barStyle")).toBe('"roomy"');
    // "review" is one day wide: too short for its title, which moves to the right of the bar
    const review = screen.getAllByRole("img", { name: /^review,/ })[0]!;
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

  it("overlays a baseline's dates as ghosts", async () => {
    await joinedBoard(ROWS, `/p/${PROJECT_ID}?baseline=${BASELINE_ID}`);
    expect(await screen.findByTestId("baseline-ghost")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: `hooks, ${d("2026-10-09")} – ${d("2026-10-12")}` })).toBeInTheDocument();
  });

  it("switches to a baseline: its dates, read-only, with a way back", async () => {
    const { user, router } = await joinedBoard(ROWS, `/p/${PROJECT_ID}?baseline=${BASELINE_ID}&compare=switch`);
    expect(await screen.findByText(/Viewing baseline/)).toHaveTextContent("Viewing baseline Kick-off (read-only)");
    expect(screen.getByRole("img", { name: `hooks, ${d("2026-10-01")} – ${d("2026-10-02")}` })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /^ui,/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to the live plan" }));
    expect(router.state.location.search).toEqual({});
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
