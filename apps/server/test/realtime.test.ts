import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CLOSE_SESSION_ENDED } from "../src/realtime/hub";
import { createUser, PUBLIC_URL, setupAdmin, useTestApp } from "./helpers";
import { connect } from "./ws-client";

const t = useTestApp();

async function team() {
  const admin = await setupAdmin(t.app);
  const ana = await createUser(t.app, admin, { email: "ana@example.com", name: "Ana", role: "editor" });
  const rudy = await createUser(t.app, admin, { email: "rudy@example.com", name: "Rudy", role: "editor" });
  const vi = await createUser(t.app, admin, { email: "vi@example.com", name: "Vi", role: "viewer" });
  const project = (await t.app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ana.cookie }, payload: { name: "Launch" } })).json().project;
  return { admin, ana, rudy, vi, projectId: project.id as string };
}

const createTask = (id: string, title = "Task") => ({ type: "createRow", id, kind: "task", parentId: null, afterId: null, title });

describe("connecting", () => {
  it("requires a signed-in user and our own origin", async () => {
    const { ana } = await team();
    await expect(connect(t.app, "")).rejects.toThrow(/401/);
    await expect(connect(t.app, ana.cookie, "https://evil.example")).rejects.toThrow(/403/);
    const client = await connect(t.app, ana.cookie, PUBLIC_URL);
    client.ws.close();
  });
});

describe("project rooms", () => {
  it("joins a project and announces who is viewing", async () => {
    const { ana, rudy, projectId } = await team();
    const a = await connect(t.app, ana.cookie);
    a.send({ type: "join", projectId, version: 0 });
    expect(await a.next("joined")).toMatchObject({ projectId, version: 0, viewers: [{ name: "Ana" }] });
    const r = await connect(t.app, rudy.cookie);
    r.send({ type: "join", projectId, version: 0 });
    await r.next("joined");
    expect((await a.next("presence", (m) => m.viewers.length === 2)).viewers.map((v) => v.name)).toEqual(["Ana", "Rudy"]);
    r.send({ type: "leave" });
    expect((await a.next("presence", (m) => m.viewers.length === 1)).viewers.map((v) => v.name)).toEqual(["Ana"]);
  });

  it("acks the sender and broadcasts the patch to everyone in the room", async () => {
    const { ana, rudy, projectId } = await team();
    const [a, r] = [await connect(t.app, ana.cookie), await connect(t.app, rudy.cookie)];
    for (const c of [a, r]) {
      c.send({ type: "join", projectId, version: 0 });
      await c.next("joined");
    }
    const commandId = randomUUID();
    const id = randomUUID();
    a.send({ type: "command", commandId, command: createTask(id, "Design") });
    expect(await a.next("ack")).toEqual({ type: "ack", commandId, version: 1 });
    const patch = await r.next("patch");
    expect(patch).toMatchObject({ projectId, version: 1, commandId, actor: { label: "Ana" }, changes: [{ rowId: id, field: "*" }] });
    await a.next("patch"); // the sender gets the patch too
  });

  it("pushes changes made over REST", async () => {
    const { ana, rudy, projectId } = await team();
    const r = await connect(t.app, rudy.cookie);
    r.send({ type: "join", projectId, version: 0 });
    await r.next("joined");
    await t.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/commands`,
      headers: { cookie: ana.cookie },
      payload: { commandId: randomUUID(), command: createTask(randomUUID()) },
    });
    expect((await r.next("patch")).version).toBe(1);
  });

  it("catches a joining client up from its version", async () => {
    const { ana, projectId } = await team();
    for (const title of ["A", "B", "C"]) {
      await t.app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/commands`,
        headers: { cookie: ana.cookie },
        payload: { commandId: randomUUID(), command: createTask(randomUUID(), title) },
      });
    }
    const a = await connect(t.app, ana.cookie);
    a.send({ type: "join", projectId, version: 1 });
    expect((await a.next("patch")).version).toBe(2);
    expect((await a.next("patch")).version).toBe(3);
    expect(await a.next("joined")).toMatchObject({ version: 3 });
  });

  it("rejects commands from viewers and before joining", async () => {
    const { vi, ana, projectId } = await team();
    const a = await connect(t.app, ana.cookie);
    a.send({ type: "command", commandId: randomUUID(), command: createTask(randomUUID()) });
    expect(await a.next("reject")).toMatchObject({ error: "invalid" });
    const v = await connect(t.app, vi.cookie);
    v.send({ type: "join", projectId, version: 0 });
    await v.next("joined");
    v.send({ type: "command", commandId: randomUUID(), command: createTask(randomUUID()) });
    expect(await v.next("reject")).toMatchObject({ error: "forbidden" });
  });

  it("reports engine rejections and malformed messages", async () => {
    const { ana, projectId } = await team();
    const a = await connect(t.app, ana.cookie);
    a.send({ type: "join", projectId, version: 0 });
    await a.next("joined");
    a.send({ type: "command", commandId: randomUUID(), command: { type: "indent", id: randomUUID() } });
    expect(await a.next("reject")).toMatchObject({ error: "not_found" });
    a.ws.send("not json");
    expect(await a.next("error")).toMatchObject({ message: "Messages must be JSON" });
  });

  it("undoes over the socket", async () => {
    const { ana, projectId } = await team();
    const a = await connect(t.app, ana.cookie);
    a.send({ type: "join", projectId, version: 0 });
    await a.next("joined");
    a.send({ type: "command", commandId: randomUUID(), command: createTask(randomUUID()) });
    await a.next("ack");
    const undoId = randomUUID();
    a.send({ type: "undo", commandId: undoId });
    expect(await a.next("ack", (m) => m.commandId === undoId)).toEqual({ type: "ack", commandId: undoId, version: 2, skipped: 0 });
  });
});

describe("other live updates", () => {
  it("announces renames to the room and calendar changes to everyone", async () => {
    const { ana, rudy, projectId } = await team();
    const a = await connect(t.app, ana.cookie);
    a.send({ type: "join", projectId, version: 0 });
    await a.next("joined");
    const r = await connect(t.app, rudy.cookie); // not in any room
    await t.app.inject({ method: "PATCH", url: `/api/projects/${projectId}`, headers: { cookie: rudy.cookie }, payload: { name: "Launch v2" } });
    expect((await a.next("project")).project.name).toBe("Launch v2");
    await t.app.inject({
      method: "POST",
      url: "/api/holidays",
      headers: { cookie: rudy.cookie },
      payload: { name: "Day off", startDate: "2026-10-05", endDate: "2026-10-05", appliesTo: "all" },
    });
    const [ia, ir] = [await a.next("instance"), await r.next("instance")];
    expect(ia.version).toBe(ir.version);
  });
});

describe("closing connections", () => {
  it("closes a session's sockets on logout", async () => {
    const { ana } = await team();
    const a = await connect(t.app, ana.cookie);
    await t.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: ana.cookie } });
    expect(await a.closed).toBe(CLOSE_SESSION_ENDED);
  });

  it("closes a user's sockets when an admin changes their role", async () => {
    const { admin, ana } = await team();
    const a = await connect(t.app, ana.cookie);
    await t.app.inject({ method: "PATCH", url: `/api/users/${ana.id}`, headers: { cookie: admin }, payload: { role: "viewer" } });
    expect(await a.closed).toBe(CLOSE_SESSION_ENDED);
  });
});
