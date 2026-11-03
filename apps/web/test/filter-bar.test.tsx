import type { ShareInfoDto } from "@ganttlines/protocol";
import { waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANA, BASELINE_ID, CALENDAR, FakeWebSocket, PROJECT_ID, projectState, section, task } from "./board-fixtures";
import { ADMIN, fakeApi, project, renderApp, screen, signedIn, type FakeApi } from "./utils";

const RUI = { ...ANA, id: "r-rui", name: "Rui Costa", userId: null };
const BEA = { ...ANA, id: "r-bea", name: "Bea Lima", userId: null };
const ROWS = [
  section("design", { title: "Design", position: "a0" }),
  task("ui", { title: "Screens", parentId: "design", position: "a0", userStart: "2026-09-30", duration: 5, resourceId: ANA.id, tags: ["UI"] }),
  task("hooks", { title: "Hooks", parentId: "design", position: "a1", userStart: "2026-10-12", duration: 2, resourceId: RUI.id }),
  section("build", { title: "Build", position: "a1" }),
  task("api", { title: "API", parentId: "build", position: "a0", userStart: "2026-10-01", duration: 2, tags: ["Backend"] }),
];

function endpoints(api: FakeApi) {
  api.on(`GET /api/projects/${PROJECT_ID}/state`, () => ({ body: projectState(ROWS) }));
  api.on("GET /api/calendar", () => ({ body: CALENDAR }));
  api.on("GET /api/resources", () => ({ body: { resources: [ANA, RUI, BEA] } }));
  api.on(`GET /api/projects/${PROJECT_ID}/highlights`, () => ({ body: { highlights: [] } }));
  api.on(`GET /api/projects/${PROJECT_ID}/baselines`, () => ({ body: { baselines: [{ id: BASELINE_ID, name: "Kick-off", createdAt: "", createdBy: "Ada" }] } }));
  api.on(`GET /api/baselines/${BASELINE_ID}`, () => ({ body: { baseline: { id: BASELINE_ID, name: "Kick-off", createdAt: "", createdBy: "Ada" }, tasks: [] } }));
}

async function board(search = "") {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const api = signedIn(ADMIN, [project(PROJECT_ID, "Launch")]);
  endpoints(api);
  const app = renderApp(`/p/${PROJECT_ID}${search}`);
  await screen.findByRole("treegrid", { name: "Tasks" });
  await waitFor(() => expect(FakeWebSocket.last.sent).toHaveLength(1));
  FakeWebSocket.last.deliver({ type: "joined", projectId: PROJECT_ID, version: 5, instanceVersion: 1, viewers: [] });
  return app;
}

const bar = () => screen.getByRole("toolbar", { name: "Filters" });
const titles = () => screen.getAllByRole("row").slice(1).map((row) => row.querySelector('[role="gridcell"]:nth-child(2)')!.textContent);
const listRow = (title: string) => screen.getAllByRole("row").find((row) => within(row).queryByText(title, { exact: true }))!;
const json = (value: unknown) => encodeURIComponent(JSON.stringify(value));

describe("the filter bar", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 29, 12));
  });
  afterEach(() => vi.useRealTimers());

  it("shows the search box and + Filter, and nothing else while not filtering", async () => {
    await board();
    expect(within(bar()).getByRole("searchbox", { name: "Search tasks" })).toHaveAttribute("placeholder", "Search tasks");
    expect(within(bar()).getByRole("button", { name: "+ Filter" })).toBeInTheDocument();
    expect(within(bar()).queryByRole("button", { name: "Clear all" })).not.toBeInTheDocument();
    expect(within(bar()).queryByText(/of \d+ tasks/)).not.toBeInTheDocument();
  });

  it("adds a person from + Filter: the address, the chip and the count follow", async () => {
    const { user, router } = await board();
    await user.click(within(bar()).getByRole("button", { name: "+ Filter" }));
    await user.click(await screen.findByRole("menuitem", { name: "People" }));
    // team members (even without tasks here) and "Unassigned"
    expect(await screen.findByRole("menuitemcheckbox", { name: "Bea Lima" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: "Unassigned" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Ana Silva" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ people: [ANA.id] }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Rui Costa" })); // the menu stays open for more
    await waitFor(() => expect(router.state.location.search).toEqual({ people: [ANA.id, RUI.id] }));
    await user.keyboard("{Escape}");
    expect(within(bar()).getByRole("button", { name: "People: Ana Silva, Rui Costa" })).toBeInTheDocument();
    expect(within(bar()).getByText("2 of 3 tasks")).toBeInTheDocument();
    expect(titles()).toEqual(["Design", "Screens", "Hooks"]);
  });

  it("lists tags used on this board and sections, with chips for each", async () => {
    const { user, router } = await board();
    await user.click(within(bar()).getByRole("button", { name: "+ Filter" }));
    await user.click(await screen.findByRole("menuitem", { name: "Tags" }));
    expect((await screen.findAllByRole("menuitemcheckbox")).map((item) => item.textContent)).toEqual(["Backend", "UI"]);
    await user.click(screen.getByRole("menuitemcheckbox", { name: "UI" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ tags: ["UI"] }));
    await user.keyboard("{Escape}");
    await user.click(within(bar()).getByRole("button", { name: "+ Filter" }));
    await user.click(await screen.findByRole("menuitem", { name: "Section" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Design" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ tags: ["UI"], sections: ["design"] }));
    await user.keyboard("{Escape}");
    expect(within(bar()).getByRole("button", { name: "Tag: UI" })).toBeInTheDocument();
    expect(within(bar()).getByRole("button", { name: "Section: Design" })).toBeInTheDocument();
  });

  it("+ Filter's Back returns to the three choices, menu still open", async () => {
    const { user } = await board();
    const choices = () => screen.getAllByRole("menuitem").map((item) => item.textContent);
    await user.click(within(bar()).getByRole("button", { name: "+ Filter" }));
    await user.click(await screen.findByRole("menuitem", { name: "People" }));
    expect(await screen.findByRole("menuitemcheckbox", { name: "Ana Silva" })).toBeInTheDocument();
    expect(choices()[0]).toBe("‹ Back");
    await user.click(screen.getByRole("menuitem", { name: "‹ Back" }));
    expect(choices()).toEqual(["People", "Tags", "Section"]);
    expect(screen.queryByRole("menuitemcheckbox")).not.toBeInTheDocument();
    // Backspace and ArrowLeft do the same
    await user.click(screen.getByRole("menuitem", { name: "Tags" }));
    expect(await screen.findByRole("menuitemcheckbox", { name: "UI" })).toBeInTheDocument();
    await user.keyboard("{Backspace}");
    expect(choices()).toEqual(["People", "Tags", "Section"]);
    await user.click(screen.getByRole("menuitem", { name: "Section" }));
    expect(await screen.findByRole("menuitemcheckbox", { name: "Design" })).toBeInTheDocument();
    await user.keyboard("{ArrowLeft}");
    expect(choices()).toEqual(["People", "Tags", "Section"]);
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("a chip's menu has no Back", async () => {
    const { user } = await board(`?people=${json([ANA.id])}`);
    await user.click(within(bar()).getByRole("button", { name: "People: Ana Silva" }));
    expect(await screen.findByRole("menuitemcheckbox", { name: "Ana Silva" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "‹ Back" })).not.toBeInTheDocument();
  });

  it("a chosen section's heading shows at full strength; the count counts tasks", async () => {
    await board(`?sections=${json(["design"])}`);
    expect(titles()).toEqual(["Design", "Screens", "Hooks"]);
    expect(listRow("Design")).not.toHaveClass("opacity-45");
    expect(within(bar()).getByText("2 of 3 tasks")).toBeInTheDocument();
  });

  it("the search finds sections: one shows with all of its tasks, and the other filters still apply inside", async () => {
    const { user } = await board();
    await user.type(within(bar()).getByRole("searchbox", { name: "Search tasks" }), "desi");
    await waitFor(() => expect(titles()).toEqual(["Design", "Screens", "Hooks"]));
    expect(listRow("Design")).not.toHaveClass("opacity-45");
    expect(within(bar()).getByText("2 of 3 tasks")).toBeInTheDocument();
  });

  it("search plus a person: the matching section with only that person's tasks", async () => {
    await board(`?q=design&people=${json([RUI.id])}`);
    expect(titles()).toEqual(["Design", "Hooks"]);
    expect(listRow("Design")).not.toHaveClass("opacity-45");
    expect(within(bar()).getByText("1 of 3 tasks")).toBeInTheDocument();
  });

  it("a chip reopens its part of the menu", async () => {
    const { user, router } = await board(`?people=${json([ANA.id])}`);
    await user.click(within(bar()).getByRole("button", { name: "People: Ana Silva" }));
    expect(await screen.findByRole("menuitemcheckbox", { name: "Ana Silva" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Unassigned" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ people: [ANA.id, "none"] }));
  });

  it("× removes one filter; Clear all removes every one", async () => {
    const { user, router } = await board(`?people=${json([ANA.id])}&tags=${json(["UI"])}&q=scr`);
    expect(within(bar()).getByText("1 of 3 tasks")).toBeInTheDocument();
    await user.click(within(bar()).getByRole("button", { name: "Remove the filter People: Ana Silva" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ tags: ["UI"], q: "scr" }));
    expect(within(bar()).queryByRole("button", { name: /^People/ })).not.toBeInTheDocument();
    await user.click(within(bar()).getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(within(bar()).getByRole("searchbox", { name: "Search tasks" })).toHaveValue("");
    expect(titles()).toHaveLength(5);
  });

  it("filters by the search box, in the address too", async () => {
    const { user, router } = await board();
    await user.type(within(bar()).getByRole("searchbox", { name: "Search tasks" }), "hoo");
    await waitFor(() => expect(router.state.location.search).toEqual({ q: "hoo" }));
    expect(titles()).toEqual(["Design", "Hooks"]);
    expect(within(bar()).getByText("1 of 3 tasks")).toBeInTheDocument();
  });

  it("dims context rows in the list and on the chart", async () => {
    await board("?q=hoo");
    expect(listRow("Design")).toHaveClass("opacity-45");
    expect(listRow("Hooks")).not.toHaveClass("opacity-45");
    const chartRows = document.querySelectorAll("[data-chart-body] [data-row]");
    expect(chartRows[0]).toHaveClass("opacity-45");
    expect(chartRows[1]).not.toHaveClass("opacity-45");
  });

  it("turns reordering, adding rows and collapsing off while filtering", async () => {
    await board("?q=hoo");
    expect(screen.queryByRole("button", { name: /^Move/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add task" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Add a subtask/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Indent/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Collapse all" })).toBeDisabled();
    expect(within(listRow("Design")).getByRole("button", { name: "Collapse" })).toBeDisabled();
  });

  it("ignores people and sections it doesn't know: no chip, nothing filtered", async () => {
    await board(`?people=${json(["r-ghost"])}&sections=${json(["gone"])}`);
    expect(within(bar()).queryByRole("button", { name: /^People|^Section/ })).not.toBeInTheDocument();
    expect(within(bar()).queryByRole("button", { name: "Clear all" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Move/ })).toHaveLength(5);
    expect(titles()).toHaveLength(5);
  });

  it("keeps the filters when a baseline is chosen", async () => {
    const { user, router } = await board(`?tags=${json(["UI"])}`);
    await user.click(screen.getByRole("button", { name: "Baseline" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Kick-off" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ tags: ["UI"], baseline: BASELINE_ID }));
    expect(within(bar()).getByRole("button", { name: "Tag: UI" })).toBeInTheDocument();
  });

  it("works on a share link, for viewers too", async () => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const info: ShareInfoDto = { project: { id: PROJECT_ID, name: "Launch" }, access: "anonymous", collaboration: false, label: "", needsSignIn: false, visitor: { name: "Sam" } };
    const api = fakeApi({
      "GET /api/auth/me": () => ({ status: 401, body: { error: "unauthorized", message: "Sign in" } }),
      "GET /api/share/tok_abc": () => ({ body: info }),
    });
    endpoints(api);
    const { user, router } = renderApp(`/s/tok_abc?q=api`);
    await screen.findByRole("treegrid", { name: "Tasks" });
    expect(titles()).toEqual(["Build", "API"]);
    await user.click(within(bar()).getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(titles()).toHaveLength(5);
  });
});
