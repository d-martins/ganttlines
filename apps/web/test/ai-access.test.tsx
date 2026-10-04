import type { McpConnectionDto, OAuthRequestDto } from "@ganttlines/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { within } from "@testing-library/react";
import { ADMIN, fakeApi, renderApp, screen, signedIn, VIEWER } from "./utils";

const REQUEST: OAuthRequestDto = {
  app: { name: "Claude", redirectHost: "claude.ai" },
  scopes: [
    { scope: "plans:read", grantable: true, requested: true },
    { scope: "plans:write", grantable: true, requested: true },
    { scope: "comments", grantable: true, requested: false },
    { scope: "team:read", grantable: true, requested: true },
    { scope: "team:write", grantable: false, requested: true },
  ],
};

const realLocation = window.location;
afterEach(() => Object.defineProperty(window, "location", { value: realLocation, configurable: true }));
function watchLeaving() {
  const assign = vi.fn();
  Object.defineProperty(window, "location", { value: { ...realLocation, assign }, configurable: true });
  return assign;
}

describe("connecting an AI app", () => {
  it("asks the signed-in person what the app may do, then sends them back with the answer", async () => {
    const assign = watchLeaving();
    const api = signedIn(ADMIN);
    api.on("GET /api/oauth/request", () => ({ body: REQUEST }));
    api.on("POST /api/oauth/consent", () => ({ body: { redirect: "https://claude.ai/cb?code=abc&state=s" } }));
    const { user } = renderApp("/connect?request=signed.request");
    expect(await screen.findByRole("heading", { name: "Allow Claude to use GanttLines?" })).toBeInTheDocument();
    expect(screen.getByText(/You'll go back to/)).toHaveTextContent("claude.ai");
    // Requested groups the person can grant come ticked; ones they can't aren't offered.
    expect(screen.getByRole("checkbox", { name: /Read plans/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Comments/ })).not.toBeChecked();
    expect(screen.queryByRole("checkbox", { name: /Edit the team calendar/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /Edit plans/ }));
    await user.click(screen.getByRole("button", { name: "Allow" }));
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("https://claude.ai/cb?code=abc&state=s"));
    expect(api.calls.find((c) => c.key === "POST /api/oauth/consent")?.body).toEqual({ request: "signed.request", approve: true, scopes: ["plans:read", "team:read"] });
  });

  it("sends people who aren't signed in to sign in first, and back here afterwards", async () => {
    fakeApi({
      "GET /api/setup": () => ({ body: { needsSetup: false } }),
      "GET /api/auth/me": () => ({ status: 401, body: { error: "unauthorized", message: "Please sign in" } }),
      "GET /api/auth/providers": () => ({ body: { oidc: null, passwordReset: false } }),
    });
    const { router } = renderApp("/connect?request=abc");
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ redirect: "/connect?request=abc" });
  });

  it("explains requests that can't go on", async () => {
    const api = signedIn(VIEWER);
    api.on("GET /api/oauth/request", () => ({ status: 400, body: { error: "bad_request", message: "This request has expired — start connecting again from the app" } }));
    renderApp("/connect?request=old");
    expect(await screen.findByRole("alert")).toHaveTextContent("This request has expired");
    renderApp("/connect?error=Unknown%20app");
    expect(await screen.findByText("Unknown app")).toBeInTheDocument();
  });
});

const CONNECTION: McpConnectionDto = { id: "c1", app: "Claude", scopes: ["plans:read", "team:read"], createdAt: "2026-10-01T10:00:00Z", lastUsedAt: null };

describe("AI access settings", () => {
  it("lets admins turn AI access on and choose what apps may do, and see everyone's connections", async () => {
    const api = signedIn(ADMIN);
    let settings = { enabled: false, scopes: ["plans:read", "plans:write", "comments", "team:read"], url: "http://localhost:3000/mcp" };
    api.on("GET /api/users", () => ({ body: { users: [ADMIN] } }));
    api.on("GET /api/calendar", () => ({ body: { instanceVersion: 1, workingWeekdays: [1, 2, 3, 4, 5], holidays: [], timeOff: [], locations: [] } }));
    api.on("GET /api/settings/mcp", () => ({ body: settings }));
    api.on("PUT /api/settings/mcp", (body) => {
      settings = { ...settings, ...(body as object) };
      return { body: settings };
    });
    api.on("GET /api/mcp/connections", (_body, url) => ({
      body: { connections: url.searchParams.get("all") ? [{ ...CONNECTION, user: { id: "u2", name: "Rudy", email: "r@example.com" } }] : [] },
    }));
    const { user } = renderApp("/settings");
    await user.click(await screen.findByLabelText("Allow AI apps to connect"));
    expect(await screen.findByLabelText("MCP server address")).toHaveTextContent("http://localhost:3000/mcp");
    await user.click(screen.getByRole("checkbox", { name: /Edit the team calendar/ }));
    expect(api.calls.filter((c) => c.key === "PUT /api/settings/mcp").map((c) => c.body)).toEqual([
      { enabled: true, scopes: ["plans:read", "plans:write", "comments", "team:read"] },
      { enabled: true, scopes: ["plans:read", "plans:write", "comments", "team:read", "team:write"] },
    ]);
    const everyone = await screen.findByRole("list", { name: "Everyone's connected AI apps" });
    expect(within(everyone).getByRole("listitem")).toHaveTextContent("Rudy");
    expect(screen.getByText(/^None\. AI apps you connect/)).toBeInTheDocument();
  });

  it("lists your own connected apps and disconnects them", async () => {
    const api = signedIn(VIEWER);
    let connections = [CONNECTION];
    api.on("GET /api/about", () => ({ body: { version: "1.2.0" } }));
    api.on("GET /api/mcp/connections", () => ({ body: { connections } }));
    api.on("DELETE /api/mcp/connections/c1", () => {
      connections = [];
      return { status: 204 };
    });
    const { user } = renderApp("/settings");
    const list = await screen.findByRole("list", { name: "Connected AI apps" });
    expect(within(list).getByRole("listitem")).toHaveTextContent("ClaudeRead plans, Team calendarlast used never");
    await user.click(within(list).getByRole("button", { name: "Disconnect" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText(/^None\. AI apps you connect/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "AI access (MCP)" })).not.toBeInTheDocument();
  });
});
