import { BOARD_LIMITS } from "@ganttlines/protocol";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createUser, setupAdmin, useTestApp } from "./helpers";
import { connect } from "./ws-client";

const t = useTestApp();

async function board() {
  const admin = await setupAdmin(t.app);
  const ana = await createUser(t.app, admin, { email: "ana@example.com", name: "Ana", role: "editor" });
  const vi = await createUser(t.app, admin, { email: "vi@example.com", name: "Vi", role: "viewer" });
  const project = (await t.app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ana.cookie }, payload: { name: "Launch" } })).json().project;
  const taskId = randomUUID();
  await t.app.inject({
    method: "POST",
    url: `/api/projects/${project.id}/commands`,
    headers: { cookie: ana.cookie },
    payload: { commandId: randomUUID(), command: { type: "createRow", id: taskId, kind: "task", parentId: null, afterId: null, title: "Design", start: "2026-10-05" } },
  });
  return { admin, ana: ana.cookie, vi: vi.cookie, projectId: project.id as string, taskId };
}

async function anonymousLink(admin: string, projectId: string, collaboration: boolean) {
  const { token } = (await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/share-links`, headers: { cookie: admin }, payload: { access: "anonymous", collaboration } })).json();
  const visit = await t.app.inject({ method: "POST", url: `/api/share/${token}/visitor`, payload: { name: "Rudy" } });
  return { "x-share-token": token as string, cookie: `gp_visitor=${visit.cookies.find((c) => c.name === "gp_visitor")!.value}` };
}

describe("comments", () => {
  it("lets viewers comment, authors edit and delete, and shows them live", async () => {
    const { ana, vi, projectId, taskId } = await board();
    const watcher = await connect(t.app, ana);
    watcher.send({ type: "join", projectId, version: 0 });
    await watcher.next("joined");
    const created = await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/comments`, headers: { cookie: vi }, payload: { taskId, body: "Can we start earlier?" } });
    expect(created.statusCode).toBe(201);
    const comment = created.json().comment;
    expect(comment).toMatchObject({ taskId, author: { label: "Vi" }, body: "Can we start earlier?", deleted: false, editedAt: null, mine: true });
    expect((await watcher.next("comment")).comment).toMatchObject({ id: comment.id, mine: false });

    expect((await t.app.inject({ method: "PATCH", url: `/api/comments/${comment.id}`, headers: { cookie: ana }, payload: { body: "hijack" } })).statusCode).toBe(403);
    const edited = await t.app.inject({ method: "PATCH", url: `/api/comments/${comment.id}`, headers: { cookie: vi }, payload: { body: "Can we start on Monday?" } });
    expect(edited.json().comment).toMatchObject({ body: "Can we start on Monday?", editedAt: expect.any(String) });

    expect((await t.app.inject({ method: "DELETE", url: `/api/comments/${comment.id}`, headers: { cookie: vi } })).statusCode).toBe(204);
    const list = (await t.app.inject({ url: `/api/projects/${projectId}/comments?taskId=${taskId}`, headers: { cookie: ana } })).json().comments;
    expect(list).toEqual([expect.objectContaining({ id: comment.id, body: "", deleted: true })]);
  });

  it("lets admins delete anyone's comment", async () => {
    const { admin, vi, projectId, taskId } = await board();
    const comment = (await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/comments`, headers: { cookie: vi }, payload: { taskId, body: "spam" } })).json().comment;
    expect((await t.app.inject({ method: "DELETE", url: `/api/comments/${comment.id}`, headers: { cookie: admin } })).statusCode).toBe(204);
  });

  it("keeps at most BOARD_LIMITS.commentsPerTask comments on a task", async () => {
    const { vi, projectId, taskId } = await board();
    await t.db.comment.createMany({
      data: Array.from({ length: BOARD_LIMITS.commentsPerTask }, () => ({ projectId, taskId, authorUserId: null, authorLabel: "Bot", body: "spam" })),
    });
    const response = await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/comments`, headers: { cookie: vi }, payload: { taskId, body: "one more" } });
    expect(response.statusCode).toBe(409);
  });

  it("only attaches comments to existing tasks", async () => {
    const { vi, projectId } = await board();
    const response = await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/comments`, headers: { cookie: vi }, payload: { taskId: randomUUID(), body: "?" } });
    expect(response.statusCode).toBe(404);
  });

  it("lets link visitors read comments, and comment only on collaborative links", async () => {
    const { admin, projectId, taskId } = await board();
    const viewOnly = await anonymousLink(admin, projectId, false);
    expect((await t.app.inject({ url: `/api/projects/${projectId}/comments`, headers: viewOnly })).statusCode).toBe(200);
    expect((await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/comments`, headers: viewOnly, payload: { taskId, body: "x" } })).statusCode).toBe(403);
    const collaborating = await anonymousLink(admin, projectId, true);
    const created = await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/comments`, headers: collaborating, payload: { taskId, body: "From the client" } });
    expect(created.json().comment.author).toEqual({ userId: null, label: "Rudy (anonymous)" });
    const commentId = created.json().comment.id;
    expect((await t.app.inject({ method: "PATCH", url: `/api/comments/${commentId}`, headers: collaborating, payload: { body: "Edited" } })).statusCode).toBe(200);
  });
});

describe("comment pages and rules", () => {
  it("pages newest first and marks the requester's own comments", async () => {
    const { ana, vi, projectId, taskId } = await board();
    for (let i = 0; i < 5; i++) {
      await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/comments`, headers: { cookie: i % 2 ? ana : vi }, payload: { taskId, body: `c${i}` } });
    }
    const first = (await t.app.inject({ url: `/api/projects/${projectId}/comments?taskId=${taskId}&limit=3`, headers: { cookie: vi } })).json();
    expect(first.comments.map((c: { body: string; mine: boolean }) => [c.body, c.mine])).toEqual([["c4", true], ["c3", false], ["c2", true]]);
    const rest = (await t.app.inject({ url: `/api/projects/${projectId}/comments?taskId=${taskId}&limit=3&before=${first.nextBefore}`, headers: { cookie: vi } })).json();
    expect(rest.comments.map((c: { body: string }) => c.body)).toEqual(["c1", "c0"]);
    expect(rest.nextBefore).toBeNull();
  });

  it("stops link visitors editing once the link is view-only", async () => {
    const { admin, projectId, taskId } = await board();
    const { token } = (await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/share-links`, headers: { cookie: admin }, payload: { access: "anonymous", collaboration: true } })).json();
    const link = (await t.app.inject({ url: `/api/projects/${projectId}/share-links`, headers: { cookie: admin } })).json().links[0];
    const visit = await t.app.inject({ method: "POST", url: `/api/share/${token}/visitor`, payload: { name: "Rudy" } });
    const headers = { "x-share-token": token as string, cookie: `gp_visitor=${visit.cookies.find((c) => c.name === "gp_visitor")!.value}` };
    const comment = (await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/comments`, headers, payload: { taskId, body: "Hi" } })).json().comment;
    await t.app.inject({ method: "PATCH", url: `/api/share-links/${link.id}`, headers: { cookie: admin }, payload: { collaboration: false } });
    expect((await t.app.inject({ method: "PATCH", url: `/api/comments/${comment.id}`, headers, payload: { body: "Changed" } })).statusCode).toBe(403);
  });
});

describe("unknown and archived projects", () => {
  it("answer 404 for projects that do not exist", async () => {
    const { ana } = await board();
    const missing = randomUUID();
    expect((await t.app.inject({ method: "POST", url: `/api/projects/${missing}/highlights`, headers: { cookie: ana }, payload: { date: "2026-10-09", color: "#ffcc00" } })).statusCode).toBe(404);
    for (const path of ["comments", "highlights", "baselines", "activity"]) {
      expect((await t.app.inject({ url: `/api/projects/${missing}/${path}`, headers: { cookie: ana } })).statusCode, path).toBe(404);
    }
  });

  it("are read-only once archived", async () => {
    const { ana, projectId, taskId } = await board();
    await t.app.inject({ method: "PATCH", url: `/api/projects/${projectId}`, headers: { cookie: ana }, payload: { archived: true } });
    const writes = await Promise.all([
      t.app.inject({ method: "POST", url: `/api/projects/${projectId}/comments`, headers: { cookie: ana }, payload: { taskId, body: "x" } }),
      t.app.inject({ method: "POST", url: `/api/projects/${projectId}/highlights`, headers: { cookie: ana }, payload: { date: "2026-10-09", color: "#ffcc00" } }),
      t.app.inject({ method: "POST", url: `/api/projects/${projectId}/baselines`, headers: { cookie: ana }, payload: { name: "x" } }),
    ]);
    expect(writes.map((r) => r.statusCode)).toEqual([409, 409, 409]);
  });
});

describe("highlights", () => {
  it("are managed by editors (incl. collaborating links), read by everyone, and pushed live", async () => {
    const { admin, ana, vi, projectId } = await board();
    const watcher = await connect(t.app, vi);
    watcher.send({ type: "join", projectId, version: 0 });
    await watcher.next("joined");
    expect((await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/highlights`, headers: { cookie: vi }, payload: { date: "2026-10-09", color: "#ffcc00" } })).statusCode).toBe(403);
    const created = await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/highlights`, headers: { cookie: ana }, payload: { date: "2026-10-09", label: "Demo", color: "#ffcc00" } });
    const highlight = created.json().highlight;
    expect((await watcher.next("highlights")).highlights).toEqual([highlight]);
    const updated = await t.app.inject({ method: "PUT", url: `/api/highlights/${highlight.id}`, headers: { cookie: ana }, payload: { date: "2026-10-12", label: "Demo day", color: "#ffcc00" } });
    expect(updated.json().highlight).toMatchObject({ date: "2026-10-12", label: "Demo day" });
    const viaLink = await anonymousLink(admin, projectId, true);
    expect((await t.app.inject({ method: "DELETE", url: `/api/highlights/${highlight.id}`, headers: viaLink })).statusCode).toBe(204);
    expect((await t.app.inject({ url: `/api/projects/${projectId}/highlights`, headers: { cookie: vi } })).json().highlights).toEqual([]);
  });
});

describe("baselines", () => {
  it("snapshot the computed dates; editors create/delete, everyone views", async () => {
    const { admin, ana, vi, projectId, taskId } = await board();
    const created = await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/baselines`, headers: { cookie: ana }, payload: { name: "Kick-off plan" } });
    expect(created.statusCode).toBe(201);
    const baseline = created.json().baseline;
    expect(baseline).toMatchObject({ name: "Kick-off plan", createdBy: "Ana" });
    const snapshot = (await t.app.inject({ url: `/api/baselines/${baseline.id}`, headers: { cookie: vi } })).json();
    expect(snapshot.tasks).toEqual([{ rowId: taskId, kind: "task", title: "Design", start: "2026-10-05", end: "2026-10-05", startsAfternoon: false, endsMidday: false }]);
    expect((await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/baselines`, headers: { cookie: vi }, payload: { name: "x" } })).statusCode).toBe(403);
    const viaLink = await anonymousLink(admin, projectId, true);
    expect((await t.app.inject({ url: `/api/projects/${projectId}/baselines`, headers: viaLink })).json().baselines).toHaveLength(1);
    expect((await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/baselines`, headers: viaLink, payload: { name: "x" } })).statusCode).toBe(401);
    expect((await t.app.inject({ method: "DELETE", url: `/api/baselines/${baseline.id}`, headers: { cookie: ana } })).statusCode).toBe(204);
  });
});

describe("activity", () => {
  it("lists changes newest first, pages, filters by row and records share links", async () => {
    const { admin, ana, vi, projectId, taskId } = await board();
    const send = (headers: Record<string, string>, command: object) =>
      t.app.inject({ method: "POST", url: `/api/projects/${projectId}/commands`, headers, payload: { commandId: randomUUID(), command } });
    await send({ cookie: ana }, { type: "updateTitle", id: taskId, title: "Design v2" });
    await send({ cookie: ana }, { type: "createRow", id: randomUUID(), kind: "task", parentId: null, afterId: null, title: "Other" });
    const viaLink = await anonymousLink(admin, projectId, true);
    await send(viaLink, { type: "setDuration", id: taskId, duration: 3 });

    const all = (await t.app.inject({ url: `/api/projects/${projectId}/activity?limit=2`, headers: { cookie: vi } })).json();
    expect(all.entries.map((e: { version: number }) => e.version)).toEqual([4, 3]);
    expect(all.entries[0]).toMatchObject({ name: "setDuration", actor: { userId: null, label: "Rudy (anonymous)", linkId: expect.any(String) }, rowIds: [taskId] });
    const older = (await t.app.inject({ url: `/api/projects/${projectId}/activity?limit=2&before=${all.nextBefore}`, headers: { cookie: vi } })).json();
    expect(older.entries.map((e: { version: number }) => e.version)).toEqual([2, 1]);
    expect(older.nextBefore).toBeNull();

    const forTask = (await t.app.inject({ url: `/api/projects/${projectId}/activity?rowId=${taskId}`, headers: { cookie: vi } })).json();
    expect(forTask.entries.map((e: { name: string }) => e.name)).toEqual(["setDuration", "updateTitle", "createRow"]);
    expect(forTask.entries[1].changes).toEqual([{ rowId: taskId, field: "title", before: "Design", after: "Design v2" }]);
    expect((await t.app.inject({ url: `/api/projects/${projectId}/activity?limit=500`, headers: { cookie: vi } })).statusCode).toBe(400);
  });
});
