import type { ShareInfoDto, ShareLinkDto } from "@ganttlines/protocol";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANA, CALENDAR, FakeWebSocket, PROJECT_ID, projectState, section, task } from "./board-fixtures";
import { ADMIN, fakeApi, project, renderApp, screen, signedIn, VIEWER, type FakeApi } from "./utils";

const TOKEN = "tok_abc";
const ROWS = [section("x", { position: "a0" }), task("ui", { parentId: "x", position: "a0", userStart: "2026-09-30", duration: 5 })];

const info = (fields: Partial<ShareInfoDto> = {}): ShareInfoDto => ({
  project: { id: PROJECT_ID, name: "Launch" },
  access: "anonymous",
  collaboration: false,
  label: "",
  needsSignIn: false,
  visitor: null,
  ...fields,
});

/** The board's own endpoints, as a link visitor sees them. */
function boardEndpoints(api: FakeApi) {
  api.on(`GET /api/projects/${PROJECT_ID}/state`, () => ({ body: projectState(ROWS) }));
  api.on("GET /api/calendar", () => ({ body: CALENDAR }));
  api.on("GET /api/resources", () => ({ body: { resources: [ANA] } }));
  api.on(`GET /api/projects/${PROJECT_ID}/highlights`, () => ({ body: { highlights: [] } }));
  api.on(`GET /api/projects/${PROJECT_ID}/baselines`, () => ({ body: { baselines: [] } }));
}

/** An anonymous visitor (nobody signed in) opening the link. */
function anonymousVisitor(first: ShareInfoDto) {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  let current = first;
  const api = fakeApi({
    "GET /api/auth/me": () => ({ status: 401, body: { error: "unauthorized", message: "Sign in" } }),
    [`GET /api/share/${TOKEN}`]: () => ({ body: current }),
  });
  boardEndpoints(api);
  return { api, setInfo: (next: ShareInfoDto) => (current = next) };
}

async function joined() {
  await waitFor(() => expect(FakeWebSocket.last.sent).toHaveLength(1));
  FakeWebSocket.last.deliver({ type: "joined", projectId: PROJECT_ID, version: 5, instanceVersion: 1, viewers: [] });
}

describe("share links", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 29, 12));
  });
  afterEach(() => vi.useRealTimers());

  it("asks anonymous visitors for a name, then shows the board read-only through the link", async () => {
    const { api, setInfo } = anonymousVisitor(info());
    api.on(`POST /api/share/${TOKEN}/visitor`, (body) => {
      setInfo(info({ visitor: { name: (body as { name: string }).name } }));
      return { body: { visitor: body } };
    });
    const { user } = renderApp(`/s/${TOKEN}`);
    await user.type(await screen.findByLabelText("Your name"), "Sam");
    await user.click(screen.getByRole("button", { name: "Open the board" }));
    expect(await screen.findByRole("treegrid", { name: "Tasks" })).toBeInTheDocument();
    await joined();
    expect(screen.getByText("Viewing via a shared link.")).toBeInTheDocument();
    expect(screen.getByText("Sam (anonymous)")).toBeInTheDocument();
    // every request carries the link's token; the socket too
    const state = api.calls.find((call) => call.key === `GET /api/projects/${PROJECT_ID}/state`)!;
    expect(state.headers["x-share-token"]).toBe(TOKEN);
    expect(FakeWebSocket.last.url).toMatch(/\/ws\?share=tok_abc$/);
    // view only: no editing, no sharing, no sidebar
    expect(screen.queryByRole("button", { name: "Add task" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("lets anonymous visitors edit and comment on collaborative links, but not change the team calendar", async () => {
    anonymousVisitor(info({ collaboration: true, visitor: { name: "Sam" } }));
    const { user } = renderApp(`/s/${TOKEN}`);
    await screen.findByRole("treegrid", { name: "Tasks" });
    await joined();
    expect(screen.getByText("Editing via a shared link — changes are saved for everyone.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add task" })).toBeInTheDocument();
    await user.dblClick(within(screen.getAllByRole("row")[2]!).getByText("2")); // the second task (row 0 is the header)
    expect(await screen.findByRole("textbox", { name: "Write a comment" })).toBeInTheDocument();
    fireEvent.contextMenu(document.querySelector("[data-chart-body]")!, { clientX: 100, clientY: 5 });
    expect(await screen.findByRole("menuitem", { name: "Highlight this day…" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Add a holiday…" })).not.toBeInTheDocument();
  });

  it("explains links that were turned off or don't exist", async () => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    fakeApi({
      "GET /api/auth/me": () => ({ status: 401, body: { error: "unauthorized", message: "Sign in" } }),
      [`GET /api/share/${TOKEN}`]: () => ({ status: 410, body: { error: "link_revoked", message: "This share link was turned off" } }),
    });
    renderApp(`/s/${TOKEN}`);
    expect(await screen.findByRole("heading", { name: "This link was turned off" })).toBeInTheDocument();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("sends people to sign in for sign-in links, and back afterwards", async () => {
    const { user, router } = (() => {
      anonymousVisitor(info({ access: "authenticated", needsSignIn: true }));
      return renderApp(`/s/${TOKEN}`);
    })();
    await user.click(await screen.findByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.search).toEqual({ redirect: `/s/${TOKEN}` });
  });

  it("lets a signed-in viewer edit through a collaborative link", async () => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const api = signedIn(VIEWER, [project(PROJECT_ID, "Launch")]);
    api.on(`GET /api/share/${TOKEN}`, () => ({ body: info({ collaboration: true }) }));
    boardEndpoints(api);
    renderApp(`/s/${TOKEN}`);
    await screen.findByRole("treegrid", { name: "Tasks" });
    await joined();
    expect(screen.getByRole("button", { name: "Add task" })).toBeInTheDocument(); // no name asked: members act as themselves
    expect(screen.getByText(VIEWER.name)).toBeInTheDocument();
  });
});

describe("sharing and managing a board", () => {
  const link = (fields: Partial<ShareLinkDto> = {}): ShareLinkDto => ({
    id: "l1",
    projectId: PROJECT_ID,
    access: "anonymous",
    collaboration: false,
    label: "",
    createdBy: "Ada Admin",
    createdAt: "2026-09-28T10:00:00Z",
    revoked: false,
    ...fields,
  });

  function editorBoard(projects = [project(PROJECT_ID, "Launch")]) {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const api = signedIn(ADMIN, projects);
    boardEndpoints(api);
    return api;
  }

  it("creates links (shown once, with a copy button), switches editing and turns links off", async () => {
    const api = editorBoard();
    const links = [link(), link({ id: "old", revoked: true })];
    api.on(`GET /api/projects/${PROJECT_ID}/share-links`, () => ({ body: { links } }));
    const created: unknown[] = [];
    api.on(`POST /api/projects/${PROJECT_ID}/share-links`, (body) => {
      created.push(body);
      return { status: 201, body: { link: link({ id: "l2" }), token: "t2", url: "http://localhost/s/t2" } };
    });
    const patched: unknown[] = [];
    api.on("PATCH /api/share-links/l1", (body) => {
      patched.push(body);
      return { body: { link: link({ collaboration: true }) } };
    });
    const deleted: string[] = [];
    api.on("DELETE /api/share-links/l1", () => {
      deleted.push("l1");
      return { status: 204 };
    });
    const { user } = renderApp(`/p/${PROJECT_ID}`);
    await screen.findByRole("treegrid", { name: "Tasks" });
    await joined();
    await user.click(screen.getByRole("button", { name: "Share" }));
    const dialog = await screen.findByRole("dialog", { name: "Share “Launch”" });
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(1); // turned-off links are left out
    await user.click(within(dialog).getByLabelText("Can edit the board (and comment)"));
    expect(within(dialog).getByRole("note")).toHaveTextContent("Anyone who gets this link can change the plan");
    await user.type(within(dialog).getByLabelText("Label (optional, for you)"), "Client");
    await user.click(within(dialog).getByRole("button", { name: "Create link" }));
    expect(await within(dialog).findByRole("textbox", { name: "New link" })).toHaveValue("http://localhost/s/t2");
    expect(created).toEqual([{ access: "anonymous", collaboration: true, label: "Client" }]);
    await user.click(within(within(dialog).getAllByRole("listitem")[0]!).getByLabelText("Can edit"));
    await waitFor(() => expect(patched).toEqual([{ collaboration: true }]));
    await user.click(within(dialog).getAllByRole("button", { name: "Turn off" })[0]!);
    await user.click(within(await screen.findByRole("dialog", { name: "Turn this link off?" })).getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(deleted).toEqual(["l1"]));
  });

  it("saves the current plan as a baseline", async () => {
    const api = editorBoard();
    const saved: unknown[] = [];
    api.on(`POST /api/projects/${PROJECT_ID}/baselines`, (body) => {
      saved.push(body);
      return { status: 201, body: { baseline: { id: "b", name: "Kick-off", createdAt: "", createdBy: "Ada" } } };
    });
    const { user } = renderApp(`/p/${PROJECT_ID}`);
    await screen.findByRole("treegrid", { name: "Tasks" });
    await joined();
    await user.click(screen.getByRole("button", { name: "Baseline" }));
    await user.click(await screen.findByRole("menuitem", { name: "Save the current plan as a baseline…" }));
    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Kick-off{Enter}");
    await waitFor(() => expect(saved).toEqual([{ name: "Kick-off" }]));
  });

  it("deletes an archived project from the sidebar, leaving its board", async () => {
    const api = editorBoard([project(PROJECT_ID, "Launch", true)]);
    let gone = false;
    api.on(`DELETE /api/projects/${PROJECT_ID}`, () => {
      gone = true;
      return { status: 204 };
    });
    api.on("GET /api/projects", (_body, url) => ({ body: { projects: gone || !url.searchParams.get("archived") ? [] : [project(PROJECT_ID, "Launch", true)] } }));
    const { user, router } = renderApp(`/p/${PROJECT_ID}`);
    await screen.findByRole("treegrid", { name: "Tasks" });
    await user.click(screen.getByRole("button", { name: /Archived \(1\)/ }));
    await user.click(screen.getByRole("button", { name: "Actions for Launch" }));
    await user.click(await screen.findByRole("menuitem", { name: /Delete…/ }));
    const confirm = await screen.findByRole("dialog", { name: "Delete “Launch”?" });
    await user.click(within(confirm).getByRole("button", { name: "Delete project" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(gone).toBe(true);
  });

  it("closes the board when the project is deleted", async () => {
    editorBoard();
    renderApp(`/p/${PROJECT_ID}`);
    await screen.findByRole("treegrid", { name: "Tasks" });
    await joined();
    FakeWebSocket.last.drop(4004);
    expect(await screen.findByText("This project was deleted.")).toBeInTheDocument();
  });
});
