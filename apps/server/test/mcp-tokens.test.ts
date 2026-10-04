import { describe, expect, it } from "vitest";
import { createUser, setupAdmin, useTestApp } from "./helpers";
import { call, enableMcp, mcpClient } from "./mcp-support";

const t = useTestApp();

const createToken = (cookie: string, body: Record<string, unknown>) => t.app.inject({ method: "POST", url: "/api/mcp/tokens", headers: { cookie }, payload: body });

describe("AI access: personal access tokens", () => {
  it("are made in Settings, shown once, and work like an approved app (limited the same way)", async () => {
    const admin = await setupAdmin(t.app);
    expect((await createToken(admin, { name: "Cursor", scopes: ["plans:read"], expiresInDays: 90 })).json()).toMatchObject({ message: "AI access is turned off on this server" });
    await enableMcp(t.app, admin);
    const viewer = await createUser(t.app, admin, { email: "vi@example.com", name: "Vi", role: "viewer" });
    expect((await t.app.inject({ url: "/api/mcp/available", headers: { cookie: viewer.cookie } })).json()).toEqual({
      enabled: true,
      url: "http://localhost:3000/mcp",
      scopes: ["plans:read", "comments", "team:read"],
    });

    const created = await createToken(viewer.cookie, { name: "Cursor on my laptop", scopes: ["plans:read", "plans:write"], expiresInDays: 90 });
    expect(created.statusCode).toBe(201);
    const { token, connection } = created.json<{ token: string; connection: { id: string; scopes: string[]; kind: string; expiresAt: string } }>();
    expect(token).toMatch(/^gl_pat_/);
    expect(connection).toMatchObject({ app: "Cursor on my laptop", kind: "token", scopes: ["plans:read"] }); // a viewer's token only reads
    expect(new Date(connection.expiresAt).getTime() - t.clock.now.getTime()).toBe(90 * 24 * 60 * 60 * 1000);

    const client = await mcpClient(t.app, token);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("list_projects");
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("add_tasks");
    expect(await call(client, "list_projects")).toEqual({ projects: [] });
    await client.close();

    const listed = (await t.app.inject({ url: "/api/mcp/connections", headers: { cookie: viewer.cookie } })).json().connections;
    expect(listed).toEqual([expect.objectContaining({ app: "Cursor on my laptop", kind: "token", lastUsedAt: expect.any(String) })]);
    expect(JSON.stringify(listed)).not.toContain(token); // never shown again

    await t.app.inject({ method: "DELETE", url: `/api/mcp/connections/${connection.id}`, headers: { cookie: viewer.cookie } });
    await expect(mcpClient(t.app, token)).rejects.toThrow();
  });

  it("stop working when they expire (or never, if asked), and edits are credited to the token's name", async () => {
    const admin = await setupAdmin(t.app);
    await enableMcp(t.app, admin);
    const monthly = (await createToken(admin, { name: "Script", scopes: ["plans:read", "plans:write"], expiresInDays: 30 })).json();
    const forever = (await createToken(admin, { name: "Forever", scopes: ["plans:read"], expiresInDays: null })).json();
    expect(forever.connection.expiresAt).toBeNull();
    expect((await createToken(admin, { name: "x", scopes: ["plans:read"], expiresInDays: 7 })).statusCode).toBe(400); // 30, 90, 365 days or never

    const client = await mcpClient(t.app, monthly.token);
    await call(client, "create_project", { name: "Launch" });
    const added = await call(client, "add_tasks", { project: "Launch", tasks: [{ title: "Design", start: "2026-10-05" }] });
    expect(added["error"]).toBeUndefined();
    await client.close();
    const projectId = (await t.app.inject({ url: "/api/projects", headers: { cookie: admin } })).json().projects[0].id;
    const history = (await t.app.inject({ url: `/api/projects/${projectId}/activity`, headers: { cookie: admin } })).json().entries;
    expect(history[0].actor.label).toBe("Admin via Script");

    t.clock.now = new Date(t.clock.now.getTime() + 31 * 24 * 60 * 60 * 1000);
    await expect(mcpClient(t.app, monthly.token)).rejects.toThrow();
    await (await mcpClient(t.app, forever.token)).close();
  });
});
