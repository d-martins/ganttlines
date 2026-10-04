import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createUser, setupAdmin, useTestApp } from "./helpers";
import { call, connect, enableMcp, mcpClient, registerApp } from "./mcp-support";

const t = useTestApp();

/** A team with one project: Design (Ana, 3 days from Mon 5 Oct) → Build (5 days, after Design), in a "Phase 1" section. */
async function plannedProject() {
  const admin = await setupAdmin(t.app);
  const editor = (await createUser(t.app, admin, { email: "ed@example.com", name: "Ed", role: "editor" })).cookie;
  const ana = (await t.app.inject({ method: "POST", url: "/api/resources", headers: { cookie: admin }, payload: { name: "Ana" } })).json().resource;
  const projectId = (await t.app.inject({ method: "POST", url: "/api/projects", headers: { cookie: editor }, payload: { name: "Launch" } })).json().project.id;
  const [phase, design, build] = [randomUUID(), randomUUID(), randomUUID()];
  const commands = [
    { type: "createRow", id: phase, kind: "section", parentId: null, afterId: null, title: "Phase 1" },
    { type: "createRow", id: design, kind: "task", parentId: phase, afterId: null, title: "Design", start: "2026-10-05" },
    { type: "setDuration", id: design, duration: 3 },
    { type: "setAssignee", id: design, resourceId: ana.id },
    { type: "createRow", id: build, kind: "task", parentId: phase, afterId: design, title: "Build", start: "2026-10-05" },
    { type: "setDuration", id: build, duration: 5 },
    { type: "linkTasks", fromId: design, toId: build },
  ];
  for (const command of commands) {
    const response = await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/commands`, headers: { cookie: editor }, payload: { commandId: randomUUID(), command } });
    expect(response.statusCode, response.body).toBe(200);
  }
  await t.app.inject({ method: "POST", url: "/api/holidays", headers: { cookie: admin }, payload: { name: "Founders' day", startDate: "2026-10-16", endDate: "2026-10-16", appliesTo: "all", locationIds: [] } });
  await enableMcp(t.app, admin);
  return { admin, editor, projectId, ana, ids: { phase, design, build } };
}

describe("AI access: read tools", () => {
  it("offers only the tool groups granted to the app (and allowed by the admin)", async () => {
    const { admin } = await plannedProject();
    const clientId = await registerApp(t.app);
    const client = await mcpClient(t.app, (await connect(t.app, admin, clientId, { grant: ["plans:read"] })).access_token);
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["find_tasks", "get_project", "get_recent_changes", "list_projects"]);

    const both = await mcpClient(t.app, (await connect(t.app, admin, clientId, { grant: ["plans:read", "team:read"] })).access_token);
    expect((await both.listTools()).tools.map((tool) => tool.name)).toContain("get_calendar");
    // The admin takes the team calendar away: it disappears at once, whatever was granted.
    await enableMcp(t.app, admin, ["plans:read"]);
    expect((await both.listTools()).tools.map((tool) => tool.name)).not.toContain("get_calendar");
    await Promise.all([client.close(), both.close()]);
  });

  it("reads projects, boards (with computed dates), searches and history", async () => {
    const { admin, ids, ana } = await plannedProject();
    const client = await mcpClient(t.app, (await connect(t.app, admin, await registerApp(t.app))).access_token);

    expect(await call(client, "list_projects")).toEqual({
      projects: [{ id: expect.any(String), name: "Launch", archived: false, tasks: 2, start: "2026-10-05", end: "2026-10-14" }],
    });

    const board = await call(client, "get_project", { project: "launch" });
    expect(board["rows"]).toEqual([
      { id: ids.phase, title: "Phase 1", depth: 0, parentId: null, type: "section" },
      expect.objectContaining({
        id: ids.design,
        title: "Design",
        depth: 1,
        type: "task",
        start: "2026-10-05",
        end: "2026-10-07",
        durationDays: 3,
        assignee: { id: ana.id, name: "Ana" },
        predecessor: null,
      }),
      // Build follows Design: 5 working days from Thu 8 end on Wed 14.
      expect.objectContaining({ id: ids.build, type: "task", start: "2026-10-08", end: "2026-10-14", predecessor: { id: ids.design, title: "Design", lagDays: 0 } }),
    ]);

    expect(await call(client, "get_project", { project: "nope" })).toEqual({ error: expect.stringContaining("No project called “nope”") });

    const anas = await call(client, "find_tasks", { assignee: "ana", from: "2026-10-06", to: "2026-10-06" });
    expect((anas["tasks"] as { title: string }[]).map((task) => task.title)).toEqual(["Design"]);
    expect(((await call(client, "find_tasks", { text: "build" }))["tasks"] as { project: { name: string } }[])[0]!.project.name).toBe("Launch");
    expect(await call(client, "find_tasks", { assignee: "Zed" })).toEqual({ error: expect.stringContaining("No team member called “Zed”") });

    const history = await call(client, "get_recent_changes", { project: "Launch", limit: 2 });
    expect(history["changes"]).toEqual([
      { at: expect.any(String), by: "Ed", change: "linkTasks", tasks: ["Build"] },
      { at: expect.any(String), by: "Ed", change: "setDuration", tasks: ["Build"] },
    ]);
    // Every answer also comes as text (which every app reads).
    const raw = await client.callTool({ name: "list_projects", arguments: {} });
    expect((raw.content as { text: string }[])[0]!.text).toMatch(/^1 project\.\n\n\{"projects":/);
    await client.close();
  });

  it("reads the team and the calendar", async () => {
    const { admin, ana } = await plannedProject();
    const client = await mcpClient(t.app, (await connect(t.app, admin, await registerApp(t.app), { grant: ["team:read"] })).access_token);
    const team = await call(client, "list_team");
    expect(team["members"]).toContainEqual({ id: ana.id, name: "Ana", active: true, location: null });
    expect(team["locations"]).toEqual([]);
    expect(await call(client, "get_calendar", { from: "2026-10-01", to: "2026-10-31" })).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
      workingWeekdays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
      holidays: [{ name: "Founders' day", start: "2026-10-16", end: "2026-10-16", for: "everyone" }],
      timeOff: [],
    });
    expect(await call(client, "get_calendar", { from: "2026-01-01", to: "2027-06-01" })).toEqual({ error: "Ask for at most a year at a time." });
    await client.close();
  });

  it("follows the person: viewers' apps can read, and losing access ends the connection", async () => {
    const { admin } = await plannedProject();
    const viewer = await createUser(t.app, admin, { email: "vi@example.com", name: "Vi", role: "viewer" });
    const clientId = await registerApp(t.app);
    const tokens = await connect(t.app, viewer.cookie, clientId);
    expect(tokens.scope).toBe("plans:read comments team:read"); // no editing groups for a viewer
    const client = await mcpClient(t.app, tokens.access_token);
    expect(((await call(client, "list_projects"))["projects"] as unknown[]).length).toBe(1);
    await client.close();

    await t.app.inject({ method: "PATCH", url: `/api/users/${viewer.id}`, headers: { cookie: admin }, payload: { role: "guest" } });
    await expect(mcpClient(t.app, tokens.access_token)).rejects.toThrow();
  });
});
