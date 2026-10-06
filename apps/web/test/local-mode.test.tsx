import { IDBFactory } from "fake-indexeddb";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetLocalWorkspace, useStorageStatus } from "../src/workspace/local";
import { serverSource, useWorkspace } from "../src/workspace";
import { ADMIN, fakeApi, renderApp, screen } from "./utils";

/** Web Locks with one other tab: `held` says whether that tab holds the workspace. */
class FakeLocks {
  holder: { reject: (error: unknown) => void } | null = null;
  async request(_name: string, options: { ifAvailable?: boolean; steal?: boolean }, callback: (lock: unknown) => Promise<void>) {
    if (this.holder && options.ifAvailable) return callback(null);
    if (this.holder && options.steal) {
      const previous = this.holder;
      this.holder = null;
      previous.reject(new DOMException("Lock stolen", "AbortError"));
    }
    return new Promise<void>((resolve, reject) => {
      this.holder = { reject };
      Promise.resolve(callback({ name: _name })).then(resolve, reject);
    });
  }
}

const signedOut = { status: 401, body: { error: "unauthorized", message: "Please sign in" } };

function visitorServer() {
  return fakeApi({
    "GET /api/setup": () => ({ body: { needsSetup: false, localForVisitors: true } }),
    "GET /api/auth/me": () => signedOut,
  });
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  forgetLocalWorkspace();
  useStorageStatus.setState({ failed: false });
  useWorkspace.setState({ source: serverSource });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  Object.defineProperty(navigator, "locks", { value: undefined, configurable: true });
});

describe("local mode", () => {
  it("lets visitors plan in their browser on a server that allows it, with a way to sign in", async () => {
    visitorServer();
    const { user } = renderApp("/");
    expect((await screen.findAllByText("No projects yet.")).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.type(screen.getByLabelText("New project name"), "Garden{Enter}");
    expect(await screen.findByRole("link", { name: "Garden" })).toBeInTheDocument();
  });

  it("still asks for sign-in when the server doesn't allow it", async () => {
    fakeApi({ "GET /api/setup": () => ({ body: { needsSetup: false } }), "GET /api/auth/me": () => signedOut });
    const { router } = renderApp("/");
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });

  it("never mixes workspaces: signing in shows the server's, signing out brings the browser's back", async () => {
    let signedIn = false;
    fakeApi({
      "GET /api/setup": () => ({ body: { needsSetup: false, localForVisitors: true } }),
      "GET /api/auth/me": () => (signedIn ? { body: { user: ADMIN } } : signedOut),
      "GET /api/auth/providers": () => ({ body: { oidc: null, passwordReset: false } }),
      "POST /api/auth/login": () => ((signedIn = true), { body: { user: ADMIN } }),
      "POST /api/auth/logout": () => ((signedIn = false), { status: 204 }),
      "GET /api/projects": () => ({ body: { projects: [{ id: "p-server", name: "Server plan", version: 0, archived: false }] } }),
    });
    const { user } = renderApp("/");
    await user.click(await screen.findByRole("button", { name: "New project" }));
    await user.type(screen.getByLabelText("New project name"), "Mine{Enter}");
    expect(await screen.findByRole("link", { name: "Mine" })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Sign in" }));
    await user.type(await screen.findByLabelText("Email"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "right");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("link", { name: "Server plan" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Mine" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByRole("link", { name: "Mine" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Server plan" })).not.toBeInTheDocument();
  });

  it("makes no server request at all in the local-only build", async () => {
    vi.stubEnv("VITE_WORKSPACE", "local");
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      calls.push(String(input));
      throw new Error("no server here");
    });
    renderApp("/");
    expect((await screen.findAllByText("No projects yet.")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "Sign in" })).not.toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it("lets one tab edit at a time: another tab can take over", async () => {
    const locks = new FakeLocks();
    locks.holder = { reject: () => undefined }; // another tab has it
    Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
    visitorServer();
    const { user } = renderApp("/");
    expect(await screen.findByText("GanttLines is open in another tab")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use here" }));
    expect((await screen.findAllByText("No projects yet.")).length).toBeGreaterThan(0);
    locks.holder?.reject(new DOMException("Lock stolen", "AbortError")); // the other tab takes it back
    expect(await screen.findByText("GanttLines is open in another tab")).toBeInTheDocument();
  });

  it("says when changes can't be saved, and keeps working", async () => {
    vi.stubGlobal("indexedDB", undefined);
    visitorServer();
    const { user } = renderApp("/");
    expect(await screen.findByRole("alert")).toHaveTextContent(/can't be saved in this browser/);
    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.type(screen.getByLabelText("New project name"), "Kept for now{Enter}");
    expect(await screen.findByRole("link", { name: "Kept for now" })).toBeInTheDocument();
  });
  it("leaves out what needs a server: sharing, people viewing, comments, history, account settings", async () => {
    visitorServer();
    const { user } = renderApp("/");
    await user.click(await screen.findByRole("button", { name: "New project" }));
    await user.type(screen.getByLabelText("New project name"), "Garden{Enter}");
    await user.click(await screen.findByRole("link", { name: "Garden" }));
    expect(await screen.findByRole("status", { name: "Saved in this browser" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "People viewing this board" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add task" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Dig{Enter}");
    const row = (await screen.findAllByRole("row")).find((candidate) => candidate.textContent?.includes("Dig"))!;
    await user.dblClick(row.querySelector('[aria-label^="Row "]')!); // the row number, as the panel tests do
    expect(await screen.findByRole("complementary", { name: /^Details of/ })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Comments" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Working days" })).toBeInTheDocument();
    for (const gone of ["Your account", "Users", "AI access (MCP)", "Email", "About"]) {
      expect(screen.queryByRole("heading", { name: gone })).not.toBeInTheDocument();
    }
  });
  async function settingsWithProject(name: string) {
    visitorServer();
    const app = renderApp("/");
    await app.user.click(await screen.findByRole("button", { name: "New project" }));
    await app.user.type(screen.getByLabelText("New project name"), `${name}{Enter}`);
    await screen.findByRole("link", { name });
    await app.user.click(screen.getByRole("link", { name: "Settings" }));
    await screen.findByRole("heading", { name: "This browser's workspace" });
    return app;
  }
  const fileOf = (text: string, size?: number) => {
    const file = new File([text], "plan.ganttlines.json", { type: "application/json" });
    if (size !== undefined) Object.defineProperty(file, "size", { value: size });
    return file;
  };

  it("exports the workspace to a file", async () => {
    const saved: Blob[] = [];
    // jsdom has no object URLs: add them (only them — the app still needs URL itself).
    Object.assign(URL, { createObjectURL: (blob: Blob) => (saved.push(blob), "blob:x"), revokeObjectURL: () => undefined });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const { user } = await settingsWithProject("Garden");
    await user.click(screen.getByRole("button", { name: "Export" }));
    expect(click).toHaveBeenCalled();
    expect(JSON.parse(await saved[0]!.text())).toMatchObject({ format: "ganttlines-workspace", projects: [expect.objectContaining({ name: "Garden" })] });
  });

  it("imports a file after saying which projects it replaces", async () => {
    const { user } = await settingsWithProject("Old");
    const { LocalSource, MemoryStore } = await import("@ganttlines/client");
    const other = await LocalSource.open(new MemoryStore());
    await other.createProject({ name: "From elsewhere" });
    await user.upload(screen.getByLabelText("Import a workspace file"), fileOf(JSON.stringify(other.exportFile())));
    const dialog = await screen.findByRole("dialog", { name: "Replace this browser's workspace?" });
    expect(dialog).toHaveTextContent("Old");
    await user.click(screen.getByRole("button", { name: "Replace" }));
    expect(await screen.findByRole("link", { name: "From elsewhere" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Old" })).not.toBeInTheDocument();
  });

  it("refuses files it can't use, before changing anything", async () => {
    const { user } = await settingsWithProject("Keep");
    await user.upload(screen.getByLabelText("Import a workspace file"), fileOf("{}", 50 * 1024 * 1024 + 1));
    expect(await screen.findByText(/too big/)).toBeInTheDocument();
    await user.upload(screen.getByLabelText("Import a workspace file"), fileOf("not json"));
    expect(await screen.findByText(/isn't a GanttLines workspace/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Keep" })).toBeInTheDocument();
  });

  it("clears the workspace after confirming", async () => {
    const { user } = await settingsWithProject("Gone soon");
    await user.click(screen.getByRole("button", { name: "Clear workspace" }));
    await user.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Gone soon" })).not.toBeInTheDocument());
  });

  it("reminds people where their work is kept", async () => {
    visitorServer();
    renderApp("/");
    expect(await screen.findByText(/Saved in this browser only/)).toBeInTheDocument();
  });
});
