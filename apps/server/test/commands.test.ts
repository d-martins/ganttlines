import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { createUser, setupAdmin, testConfig, useTestApp } from "./helpers";

const t = useTestApp();

async function editorWithProject() {
  const admin = await setupAdmin(t.app);
  const editor = (await createUser(t.app, admin, { email: "ed@example.com", name: "Ed", role: "editor" })).cookie;
  const project = (await t.app.inject({ method: "POST", url: "/api/projects", headers: { cookie: editor }, payload: { name: "Launch" } })).json().project;
  return { admin, editor, projectId: project.id as string };
}

function send(cookie: string, projectId: string, command: object, commandId: string = randomUUID()) {
  return t.app.inject({ method: "POST", url: `/api/projects/${projectId}/commands`, headers: { cookie }, payload: { commandId, command } });
}

const createTask = (id: string, title = "Task", start?: string) => ({
  type: "createRow",
  id,
  kind: "task",
  parentId: null,
  afterId: null,
  title,
  ...(start ? { start } : {}),
});

describe("project commands", () => {
  it("applies a command, bumps the version and persists the rows", async () => {
    const { editor, projectId } = await editorWithProject();
    const id = randomUUID();
    const response = await send(editor, projectId, createTask(id, "Design", "2026-10-05"));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ version: 1, changes: [{ rowId: id, field: "*", before: null }] });

    const state = (await t.app.inject({ url: `/api/projects/${projectId}/state`, headers: { cookie: editor } })).json();
    expect(state.project.version).toBe(1);
    expect(state.rows).toEqual([expect.objectContaining({ id, title: "Design", userStart: "2026-10-05" })]);

    // A fresh server (empty cache) reads the same state back from the database.
    const restarted = await buildApp({ db: t.db, config: testConfig });
    const reloaded = (await restarted.inject({ url: `/api/projects/${projectId}/state`, headers: { cookie: editor } })).json();
    await restarted.close();
    expect(reloaded).toEqual(state);
  });

  it("returns the original result when a command is retried with the same commandId", async () => {
    const { editor, projectId } = await editorWithProject();
    const commandId = randomUUID();
    const command = createTask(randomUUID());
    const first = await send(editor, projectId, command, commandId);
    const retry = await send(editor, projectId, command, commandId);
    expect(retry.json()).toEqual(first.json());
    expect(await t.db.commandLog.count({ where: { projectId } })).toBe(1);
  });

  it("rejects invalid commands with the engine's reason and changes nothing", async () => {
    const { editor, projectId } = await editorWithProject();
    const id = randomUUID();
    await send(editor, projectId, createTask(id));
    const rejected = await send(editor, projectId, { type: "indent", id });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toMatchObject({ error: "invalid" });
    const missing = await send(editor, projectId, { type: "updateTitle", id: randomUUID(), title: "x" });
    expect(missing.json().error).toBe("not_found");
    expect((await t.app.inject({ url: `/api/projects/${projectId}/state`, headers: { cookie: editor } })).json().project.version).toBe(1);
  });

  it("does not bump the version for commands that change nothing", async () => {
    const { editor, projectId } = await editorWithProject();
    const id = randomUUID();
    await send(editor, projectId, createTask(id, "Same"));
    const noop = await send(editor, projectId, { type: "updateTitle", id, title: "Same" });
    expect(noop.json()).toEqual({ version: 1, changes: [] });
  });

  it("validates payloads", async () => {
    const { editor, projectId } = await editorWithProject();
    const response = await send(editor, projectId, { type: "updateTitle", id: "row-1", title: "x" });
    expect(response.statusCode).toBe(400);
  });

  it("schedules against the team calendar", async () => {
    const { editor, projectId } = await editorWithProject();
    await t.app.inject({
      method: "POST",
      url: "/api/holidays",
      headers: { cookie: editor },
      payload: { name: "Republic Day", startDate: "2026-10-05", endDate: "2026-10-05", appliesTo: "all" },
    });
    const id = randomUUID();
    await send(editor, projectId, createTask(id, "Design", "2026-10-05"));
    const state = (await t.app.inject({ url: `/api/projects/${projectId}/state`, headers: { cookie: editor } })).json();
    expect(state.rows[0].userStart).toBe("2026-10-06");
  });

  it("only assigns existing, active team members", async () => {
    const { editor, projectId } = await editorWithProject();
    const id = randomUUID();
    await send(editor, projectId, createTask(id));
    const ana = (await t.app.inject({ method: "POST", url: "/api/resources", headers: { cookie: editor }, payload: { name: "Ana" } })).json().resource;
    expect((await send(editor, projectId, { type: "setAssignee", id, resourceId: ana.id })).statusCode).toBe(200);
    await t.app.inject({ method: "PATCH", url: `/api/resources/${ana.id}`, headers: { cookie: editor }, payload: { inactive: true } });
    const other = randomUUID();
    await send(editor, projectId, createTask(other));
    const inactive = await send(editor, projectId, { type: "setAssignee", id: other, resourceId: ana.id });
    expect(inactive.statusCode).toBe(422);
    const unknown = await send(editor, projectId, { type: "setAssignee", id, resourceId: randomUUID() });
    expect(unknown.statusCode).toBe(422);
  });

  it("applies concurrent commands one at a time with consecutive versions", async () => {
    const { editor, projectId } = await editorWithProject();
    const responses = await Promise.all(Array.from({ length: 15 }, (_, i) => send(editor, projectId, createTask(randomUUID(), `T${i}`))));
    expect(responses.map((r) => r.json().version).sort((a, b) => a - b)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    const state = (await t.app.inject({ url: `/api/projects/${projectId}/state`, headers: { cookie: editor } })).json();
    expect(state.rows).toHaveLength(15);
  });

  it("lets only editors send commands, and not to archived projects", async () => {
    const { admin, editor, projectId } = await editorWithProject();
    const viewer = await createUser(t.app, admin, { email: "v@example.com", name: "Vi", role: "viewer" });
    expect((await send(viewer.cookie, projectId, createTask(randomUUID()))).statusCode).toBe(403);
    await t.app.inject({ method: "PATCH", url: `/api/projects/${projectId}`, headers: { cookie: editor }, payload: { archived: true } });
    expect((await send(editor, projectId, createTask(randomUUID()))).statusCode).toBe(409);
  });
});

describe("robustness", () => {
  it("recovers when the database moved on without the server (stale cache)", async () => {
    const { editor, projectId } = await editorWithProject();
    await send(editor, projectId, createTask(randomUUID()));
    await t.db.project.update({ where: { id: projectId }, data: { version: 7 } });
    const stale = await send(editor, projectId, createTask(randomUUID()));
    expect(stale.statusCode).toBe(409);
    const retried = await send(editor, projectId, createTask(randomUUID()));
    expect(retried.json().version).toBe(8);
  });

  it("refuses to reuse a commandId for a different command, in any project", async () => {
    const { editor, projectId } = await editorWithProject();
    const other = (await t.app.inject({ method: "POST", url: "/api/projects", headers: { cookie: editor }, payload: { name: "Other" } })).json().project;
    const commandId = randomUUID();
    await send(editor, projectId, createTask(randomUUID(), "A"), commandId);
    expect((await send(editor, projectId, createTask(randomUUID(), "B"), commandId)).statusCode).toBe(409);
    expect((await send(editor, other.id, createTask(randomUUID(), "A"), commandId)).statusCode).toBe(409);
  });

  it("does not confuse no-op outcomes across projects that reuse a commandId", async () => {
    const { editor, projectId } = await editorWithProject();
    const other = (await t.app.inject({ method: "POST", url: "/api/projects", headers: { cookie: editor }, payload: { name: "Other" } })).json().project;
    const id = randomUUID();
    await send(editor, projectId, createTask(id, "Same"));
    const commandId = randomUUID();
    await send(editor, projectId, { type: "updateTitle", id, title: "Same" }, commandId); // no-op in project 1
    const elsewhere = await send(editor, other.id, { type: "updateTitle", id, title: "Same" }, commandId);
    expect(elsewhere.json().error).toBe("not_found"); // evaluated for project 2, not project 1's answer
  });

  it("stays usable after a failed write (row id already used in another project)", async () => {
    const { editor, projectId } = await editorWithProject();
    const other = (await t.app.inject({ method: "POST", url: "/api/projects", headers: { cookie: editor }, payload: { name: "Other" } })).json().project;
    const id = randomUUID();
    await send(editor, other.id, createTask(id));
    expect((await send(editor, projectId, createTask(id))).statusCode).toBe(409);
    const next = await send(editor, projectId, createTask(randomUUID()));
    expect(next.json().version).toBe(1);
  });

  it("keeps a task's current assignee even after they were deactivated", async () => {
    const { editor, projectId } = await editorWithProject();
    const id = randomUUID();
    await send(editor, projectId, createTask(id));
    const ana = (await t.app.inject({ method: "POST", url: "/api/resources", headers: { cookie: editor }, payload: { name: "Ana" } })).json().resource;
    await send(editor, projectId, { type: "setAssignee", id, resourceId: ana.id });
    await t.app.inject({ method: "PATCH", url: `/api/resources/${ana.id}`, headers: { cookie: editor }, payload: { inactive: true } });
    const same = await send(editor, projectId, { type: "setAssignee", id, resourceId: ana.id });
    expect(same.json()).toEqual({ version: 2, changes: [] });
  });

  it("deletes many rows in one command", async () => {
    const { editor, projectId } = await editorWithProject();
    const ids = Array.from({ length: 60 }, () => randomUUID());
    for (const id of ids) await send(editor, projectId, createTask(id));
    const response = await send(editor, projectId, { type: "deleteRows", ids });
    expect(response.statusCode).toBe(200);
    expect(await t.db.row.count({ where: { projectId } })).toBe(0);
  });
});

describe("catching up", () => {
  it("returns the changes after a version", async () => {
    const { editor, projectId } = await editorWithProject();
    const [a, b] = [randomUUID(), randomUUID()];
    await send(editor, projectId, createTask(a, "A"));
    const second = await send(editor, projectId, createTask(b, "B"));
    const changes = (await t.app.inject({ url: `/api/projects/${projectId}/changes?since=1`, headers: { cookie: editor } })).json();
    expect(changes).toEqual({
      version: 2,
      entries: [{ version: 2, commandId: expect.any(String), actor: { userId: expect.any(String), label: "Ed" }, changes: second.json().changes }],
    });
  });

  it("asks clients that are too far behind to reload", async () => {
    const { editor, projectId } = await editorWithProject();
    await t.db.project.update({ where: { id: projectId }, data: { version: 600 } });
    const fresh = await buildApp({ db: t.db, config: testConfig });
    const response = (await fresh.inject({ url: `/api/projects/${projectId}/changes?since=10`, headers: { cookie: editor } })).json();
    await fresh.close();
    expect(response).toEqual({ version: 600, reload: true });
  });

  it("asks clients that claim to be ahead to reload", async () => {
    const { editor, projectId } = await editorWithProject();
    const response = (await t.app.inject({ url: `/api/projects/${projectId}/changes?since=99`, headers: { cookie: editor } })).json();
    expect(response).toEqual({ version: 0, reload: true });
  });

  it("validates `since`", async () => {
    const { editor, projectId } = await editorWithProject();
    expect((await t.app.inject({ url: `/api/projects/${projectId}/changes?since=abc`, headers: { cookie: editor } })).statusCode).toBe(400);
  });
});
