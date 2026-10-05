import { toDbColumns } from "@ganttlines/db";
import { TASK_DEFAULTS, type Row } from "@ganttlines/engine";
import { describe, expect, it } from "vitest";
import { findTreeProblem } from "../src/projects/state";
import { randomUUID } from "node:crypto";
import { CLOSE_PROJECT_DELETED } from "../src/realtime/hub";
import { InstanceService } from "../src/calendar/instance-service";
import { ProjectService } from "../src/projects/project-service";
import { createUser, setupAdmin, useTestApp } from "./helpers";
import { connect } from "./ws-client";

const t = useTestApp();

const SECTION_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const rows: Row[] = [
  { id: SECTION_ID, kind: "section", title: "Phase 1", parentId: null, position: "a0" },
  { ...TASK_DEFAULTS, id: TASK_ID, kind: "task", title: "Build", parentId: SECTION_ID, position: "a0", userStart: "2026-10-05", duration: 3 },
];

describe("projects", () => {
  it("lets editors create, rename and archive projects", async () => {
    const admin = await setupAdmin(t.app);
    const editor = await createUser(t.app, admin, { email: "ed@example.com", name: "Ed", role: "editor" });
    const created = await t.app.inject({ method: "POST", url: "/api/projects", headers: { cookie: editor.cookie }, payload: { name: "Launch" } });
    expect(created.statusCode).toBe(201);
    const project = created.json().project;
    expect(project).toMatchObject({ name: "Launch", version: 0, archived: false });

    const renamed = await t.app.inject({ method: "PATCH", url: `/api/projects/${project.id}`, headers: { cookie: editor.cookie }, payload: { name: "Launch v2" } });
    expect(renamed.json().project.name).toBe("Launch v2");

    await t.app.inject({ method: "PATCH", url: `/api/projects/${project.id}`, headers: { cookie: editor.cookie }, payload: { archived: true } });
    expect((await t.app.inject({ url: "/api/projects", headers: { cookie: editor.cookie } })).json().projects).toEqual([]);
    const all = await t.app.inject({ url: "/api/projects?archived=true", headers: { cookie: editor.cookie } });
    expect(all.json().projects).toHaveLength(1);
  });

  it("lets viewers read but not create; guests see no projects", async () => {
    const admin = await setupAdmin(t.app);
    await t.app.inject({ method: "POST", url: "/api/projects", headers: { cookie: admin }, payload: { name: "Launch" } });
    const viewer = await createUser(t.app, admin, { email: "v@example.com", name: "Vi", role: "viewer" });
    const guest = await createUser(t.app, admin, { email: "g@example.com", name: "Gu", role: "guest" });
    expect((await t.app.inject({ url: "/api/projects", headers: { cookie: viewer.cookie } })).json().projects).toHaveLength(1);
    expect((await t.app.inject({ method: "POST", url: "/api/projects", headers: { cookie: viewer.cookie }, payload: { name: "X" } })).statusCode).toBe(403);
    expect((await t.app.inject({ url: "/api/projects", headers: { cookie: guest.cookie } })).json().projects).toEqual([]);
  });

  it("does not let viewers rename projects, nor guests read project state", async () => {
    const admin = await setupAdmin(t.app);
    const project = (await t.app.inject({ method: "POST", url: "/api/projects", headers: { cookie: admin }, payload: { name: "Launch" } })).json().project;
    const viewer = await createUser(t.app, admin, { email: "v@example.com", name: "Vi", role: "viewer" });
    const guest = await createUser(t.app, admin, { email: "g@example.com", name: "Gu", role: "guest" });
    const rename = await t.app.inject({ method: "PATCH", url: `/api/projects/${project.id}`, headers: { cookie: viewer.cookie }, payload: { name: "X" } });
    expect(rename.statusCode).toBe(403);
    expect((await t.app.inject({ url: `/api/projects/${project.id}/state`, headers: { cookie: guest.cookie } })).statusCode).toBe(403);
  });

  it("loads a project's full state as engine rows", async () => {
    const admin = await setupAdmin(t.app);
    const project = (await t.app.inject({ method: "POST", url: "/api/projects", headers: { cookie: admin }, payload: { name: "Launch" } })).json().project;
    await t.db.row.createMany({ data: rows.map((row) => ({ ...toDbColumns(row), projectId: project.id })) });
    const state = await t.app.inject({ url: `/api/projects/${project.id}/state`, headers: { cookie: admin } });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toEqual({ project, rows: expect.arrayContaining(rows) });
  });

  it("refuses to serve a project with corrupted parent links", async () => {
    const admin = await setupAdmin(t.app);
    const project = (await t.app.inject({ method: "POST", url: "/api/projects", headers: { cookie: admin }, payload: { name: "Launch" } })).json().project;
    const orphan = { ...rows[1]!, parentId: "33333333-3333-4333-8333-333333333333" };
    await t.db.row.create({ data: { ...toDbColumns(orphan), projectId: project.id } });
    const state = await t.app.inject({ url: `/api/projects/${project.id}/state`, headers: { cookie: admin } });
    expect(state.statusCode).toBe(500);
    expect(state.json().error).toBe("project_corrupt");
  });

  it("reports rows with an unknown kind as corruption", async () => {
    const admin = await setupAdmin(t.app);
    const project = (await t.app.inject({ method: "POST", url: "/api/projects", headers: { cookie: admin }, payload: { name: "Launch" } })).json().project;
    await t.db.row.create({ data: { ...toDbColumns(rows[1]!), parentId: null, kind: "epic", projectId: project.id } });
    const state = await t.app.inject({ url: `/api/projects/${project.id}/state`, headers: { cookie: admin } });
    expect(state.statusCode).toBe(500);
    expect(state.json().error).toBe("project_corrupt");
  });

  it("returns 404 for unknown projects", async () => {
    const admin = await setupAdmin(t.app);
    const state = await t.app.inject({ url: "/api/projects/00000000-0000-4000-8000-000000000000/state", headers: { cookie: admin } });
    expect(state.statusCode).toBe(404);
  });
});

describe("findTreeProblem", () => {
  it("accepts a valid tree", () => {
    expect(findTreeProblem(rows)).toBeNull();
  });

  it("detects missing predecessors", () => {
    const [, task] = rows as [Row, Row];
    expect(findTreeProblem([rows[0]!, { ...task, predecessorId: "33333333-3333-4333-8333-333333333333" } as Row])).toMatch(/missing predecessor/);
  });

  it("detects missing parents, parent loops and sections inside tasks", () => {
    const [section, task] = rows as [Row, Row];
    expect(findTreeProblem([task])).toMatch(/missing parent/);
    expect(findTreeProblem([{ ...section, parentId: task.id }, task])).toMatch(/section .* is inside task|loop/);
    expect(findTreeProblem([{ ...task, parentId: TASK_ID }])).toMatch(/loop/);
  });

  it("deletes archived projects only — with their rows, history, comments and links — and closes their boards", async () => {
    const admin = await setupAdmin(t.app);
    const editor = await createUser(t.app, admin, { email: "ed@example.com", name: "Ed", role: "editor" });
    const viewer = await createUser(t.app, admin, { email: "v@example.com", name: "Vi", role: "viewer" });
    const as = (cookie: string) => ({ cookie });
    const id = (await t.app.inject({ method: "POST", url: "/api/projects", headers: as(editor.cookie), payload: { name: "Old" } })).json().project.id;
    const taskId = randomUUID();
    await t.app.inject({
      method: "POST",
      url: `/api/projects/${id}/commands`,
      headers: as(editor.cookie),
      payload: { commandId: randomUUID(), command: { type: "createRow", id: taskId, kind: "task", parentId: null, afterId: null, title: "T" } },
    });
    await t.app.inject({ method: "POST", url: `/api/projects/${id}/comments`, headers: as(editor.cookie), payload: { taskId, body: "hi" } });
    await t.app.inject({ method: "POST", url: `/api/projects/${id}/share-links`, headers: as(editor.cookie), payload: { access: "anonymous" } });

    const remove = (cookie: string) => t.app.inject({ method: "DELETE", url: `/api/projects/${id}`, headers: as(cookie) });
    expect((await remove(editor.cookie)).statusCode).toBe(409); // archive first
    await t.app.inject({ method: "PATCH", url: `/api/projects/${id}`, headers: as(editor.cookie), payload: { archived: true } });
    expect((await remove(viewer.cookie)).statusCode).toBe(403);

    const board = await connect(t.app, viewer.cookie);
    board.send({ type: "join", projectId: id, version: 0 });
    await board.next("joined");
    expect((await remove(editor.cookie)).statusCode).toBe(204);
    expect(await board.closed).toBe(CLOSE_PROJECT_DELETED);

    expect((await t.app.inject({ url: `/api/projects/${id}/state`, headers: as(editor.cookie) })).statusCode).toBe(404);
    expect((await t.app.inject({ url: "/api/projects?archived=true", headers: as(editor.cookie) })).json().projects).toEqual([]);
    expect(await t.db.row.count()).toBe(0);
    expect(await t.db.commandLog.count({ where: { projectId: id } })).toBe(0);
    expect(await t.db.comment.count()).toBe(0);
    expect(await t.db.shareLink.count()).toBe(0);
    expect((await remove(editor.cookie)).statusCode).toBe(404);
  });
});

describe("the cache of boards", () => {
  it("forgets boards nobody used for a while — whether they were opened live or only through the API", async () => {
    const admin = await setupAdmin(t.app);
    const { id } = (await t.app.inject({ method: "POST", url: "/api/projects", headers: { cookie: admin }, payload: { name: "Launch" } })).json().project;
    const projects = new ProjectService(t.db, new InstanceService(t.db));
    await projects.state(id);
    expect(projects.cachedProjects).toBe(1);
    await projects.evictIdle(60_000, () => false);
    expect(projects.cachedProjects).toBe(1); // used just now
    await projects.evictIdle(0, () => true);
    expect(projects.cachedProjects).toBe(1); // open on a board
    await projects.evictIdle(0, () => false);
    expect(projects.cachedProjects).toBe(0);
  });
});
