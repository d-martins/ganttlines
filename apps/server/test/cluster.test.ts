import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, inject, it } from "vitest";
import { CLOSE_PROJECT_DELETED, CLOSE_SESSION_ENDED } from "../src/realtime/hub";
import { createUser, setupAdmin, testApp, testConfig, useTestApp } from "./helpers";
import { connect } from "./ws-client";

const t = useTestApp();
const copies: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(copies.splice(0).map((copy) => copy.close()));
});

/** Two copies of the server sharing the test database, coordinating through Postgres. */
async function twoCopies() {
  const config = { ...testConfig, cluster: "postgres" as const, databaseUrl: inject("databaseUrl") };
  const [a, b] = await Promise.all([testApp({ db: t.db, config }), testApp({ db: t.db, config })]);
  copies.push(a, b);
  const admin = await setupAdmin(a);
  const ed = await createUser(a, admin, { email: "ed@example.com", name: "Ed", role: "editor" });
  const projectId = (await a.inject({ method: "POST", url: "/api/projects", headers: { cookie: ed.cookie }, payload: { name: "Launch" } })).json().project.id as string;
  return { a, b, admin, ed, projectId };
}

const command = (app: FastifyInstance, cookie: string, projectId: string, command: object) =>
  app.inject({ method: "POST", url: `/api/projects/${projectId}/commands`, headers: { cookie }, payload: { commandId: randomUUID(), command } });
const createTask = (title: string) => ({ type: "createRow", id: randomUUID(), kind: "task", parentId: null, afterId: null, title });
const state = async (app: FastifyInstance, cookie: string, projectId: string) =>
  (await app.inject({ url: `/api/projects/${projectId}/state`, headers: { cookie } })).json() as { project: { version: number; name: string }; rows: { title: string }[] };

describe("several copies: board edits", () => {
  it("applies simultaneous edits from both copies, one after another, and both copies agree", async () => {
    const { a, b, ed, projectId } = await twoCopies();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => command(i % 2 ? b : a, ed.cookie, projectId, createTask(`T${i}`))));
    expect(results.map((r) => r.statusCode)).toEqual(Array(20).fill(200));
    expect(results.map((r) => r.json().version).sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const [atA, atB] = await Promise.all([state(a, ed.cookie, projectId), state(b, ed.cookie, projectId)]);
    expect(atA.project.version).toBe(20);
    expect(atB.project.version).toBe(20);
    expect(atA.rows.map((row) => row.title).sort()).toEqual(atB.rows.map((row) => row.title).sort());
  });

  it("catches a copy's cached board up with edits made on the other copy (and renames)", async () => {
    const { a, b, ed, projectId } = await twoCopies();
    await state(b, ed.cookie, projectId); // B caches the board at version 0
    await command(a, ed.cookie, projectId, createTask("Design"));
    await a.inject({ method: "PATCH", url: `/api/projects/${projectId}`, headers: { cookie: ed.cookie }, payload: { name: "Launch 2" } });
    const atB = await state(b, ed.cookie, projectId);
    expect(atB.rows.map((row) => row.title)).toEqual(["Design"]);
    expect(atB.project.name).toBe("Launch 2");
    // and B's next edit builds on it
    expect((await command(b, ed.cookie, projectId, createTask("Build"))).json().version).toBe(2);
  });

  it("reloads a board that fell too far behind instead of replaying a long history", async () => {
    const { a, b, ed, projectId } = await twoCopies();
    await state(b, ed.cookie, projectId);
    const id = randomUUID();
    await command(a, ed.cookie, projectId, { ...createTask("Counter"), id });
    for (let i = 0; i < 501; i++) await command(a, ed.cookie, projectId, { type: "updateTitle", id, title: `Counter ${i}` });
    const atB = await state(b, ed.cookie, projectId);
    expect(atB.project.version).toBe(502);
    expect(atB.rows.map((row) => row.title)).toEqual(["Counter 500"]);
  }, 60_000);
});

describe("several copies: team calendar", () => {
  it("serialises changes from both copies, each with its own version", async () => {
    const { a, b, admin } = await twoCopies();
    const add = (app: FastifyInstance, name: string) => app.inject({ method: "POST", url: "/api/resources", headers: { cookie: admin }, payload: { name } });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => add(i % 2 ? b : a, `P${i}`)));
    expect(results.map((r) => r.statusCode)).toEqual(Array(10).fill(201));
    const versions = (await t.db.commandLog.findMany({ where: { projectId: null }, select: { version: true } })).map((e) => e.version);
    expect(new Set(versions).size).toBe(versions.length); // every change got its own version
  });
});

describe("several copies: live updates", () => {
  it("sends edits made on one copy to browsers on the other, in order", async () => {
    const { a, b, ed, projectId } = await twoCopies();
    const onB = await connect(b, ed.cookie);
    onB.send({ type: "join", projectId, version: 0 });
    await onB.next("joined");
    for (let i = 0; i < 5; i++) await command(a, ed.cookie, projectId, createTask(`T${i}`));
    const versions: number[] = [];
    for (let i = 0; i < 5; i++) versions.push((await onB.next("patch")).version);
    expect(versions).toEqual([1, 2, 3, 4, 5]);
    onB.ws.close();
  });

  it("relays renames, team calendar changes, comments and highlights", async () => {
    const { a, b, admin, ed, projectId } = await twoCopies();
    const taskId = randomUUID();
    await command(a, ed.cookie, projectId, { ...createTask("Design"), id: taskId });
    const onB = await connect(b, ed.cookie);
    onB.send({ type: "join", projectId, version: 1 });
    await onB.next("joined");
    await a.inject({ method: "PATCH", url: `/api/projects/${projectId}`, headers: { cookie: ed.cookie }, payload: { name: "Launch 2" } });
    expect((await onB.next("project")).project.name).toBe("Launch 2");
    await a.inject({ method: "POST", url: "/api/resources", headers: { cookie: admin }, payload: { name: "Ana" } });
    expect((await onB.next("instance")).version).toBeGreaterThan(0);
    expect((await b.inject({ url: "/api/resources", headers: { cookie: ed.cookie } })).json().resources.map((r: { name: string }) => r.name)).toContain("Ana");
    await a.inject({ method: "POST", url: `/api/projects/${projectId}/comments`, headers: { cookie: ed.cookie }, payload: { taskId, body: "Hi" } });
    expect(await onB.next("comment")).toMatchObject({ comment: { body: "Hi", mine: true } });
    await a.inject({ method: "POST", url: `/api/projects/${projectId}/highlights`, headers: { cookie: ed.cookie }, payload: { date: "2026-10-09", color: "#ff0000" } });
    expect((await onB.next("highlights")).highlights).toHaveLength(1);
    onB.ws.close();
  });

  it("signs people out, and closes deleted projects, on every copy", async () => {
    const { a, b, admin, ed, projectId } = await twoCopies();
    const onB = await connect(b, ed.cookie);
    const edId = (await a.inject({ url: "/api/auth/me", headers: { cookie: ed.cookie } })).json().user.id;
    await a.inject({ method: "PATCH", url: `/api/users/${edId}`, headers: { cookie: admin }, payload: { role: "viewer" } });
    expect(await onB.closed).toBe(CLOSE_SESSION_ENDED);

    const adminOnB = await connect(b, admin);
    adminOnB.send({ type: "join", projectId, version: 0 });
    await adminOnB.next("joined");
    await a.inject({ method: "PATCH", url: `/api/projects/${projectId}`, headers: { cookie: admin }, payload: { archived: true } });
    await a.inject({ method: "DELETE", url: `/api/projects/${projectId}`, headers: { cookie: admin } });
    expect(await adminOnB.closed).toBe(CLOSE_PROJECT_DELETED);
    expect((await b.inject({ url: `/api/projects/${projectId}/state`, headers: { cookie: admin } })).statusCode).toBe(404);
  });

  it("asks browsers to reconnect when the copy may have missed events", async () => {
    const { b, ed } = await twoCopies();
    const onB = await connect(b, ed.cookie);
    await t.db.$executeRawUnsafe("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'ganttlines-listener'");
    expect(await onB.closed).toBe(1012);
  });
});

describe("several copies: who's viewing", () => {
  it("shows people on both copies, and drops a copy's viewers when it stops", async () => {
    const { a, b, admin, ed, projectId } = await twoCopies();
    const onA = await connect(a, admin);
    onA.send({ type: "join", projectId, version: 0 });
    await onA.next("joined");
    const onB = await connect(b, ed.cookie);
    onB.send({ type: "join", projectId, version: 0 });
    expect((await onB.next("joined")).viewers.map((v) => v.name).sort()).toEqual(["Admin", "Ed"]);
    expect((await onA.next("presence", (m) => m.viewers.length === 2)).viewers.map((v) => v.name).sort()).toEqual(["Admin", "Ed"]);
    copies.splice(copies.indexOf(a), 1);
    await a.close();
    expect((await onB.next("presence", (m) => m.viewers.length === 1)).viewers.map((v) => v.name)).toEqual(["Ed"]);
    onB.ws.close();
  });
});

describe("several copies: revocations hold even if a notification is lost", () => {
  it("never serves a share link from a cache that another copy could have made stale", async () => {
    const { a, b, admin, projectId } = await twoCopies();
    const { token, link } = (await a.inject({ method: "POST", url: `/api/projects/${projectId}/share-links`, headers: { cookie: admin }, payload: { access: "anonymous" } })).json();
    expect((await b.inject({ url: `/api/share/${token}` })).statusCode).toBe(200);
    await t.db.shareLink.update({ where: { id: link.id }, data: { revokedAt: new Date() } }); // revoked, nobody told B
    expect((await b.inject({ url: `/api/share/${token}` })).statusCode).toBe(410);
  });

  it("checks a live connection's person again before each command", async () => {
    const { b, ed, projectId } = await twoCopies();
    const onB = await connect(b, ed.cookie);
    onB.send({ type: "join", projectId, version: 0 });
    await onB.next("joined");
    await t.db.user.update({ where: { email: "ed@example.com" }, data: { role: "viewer" } }); // demoted, nobody told B
    onB.send({ type: "command", commandId: randomUUID(), command: createTask("Sneaky") });
    expect(await onB.next("reject")).toMatchObject({ error: "forbidden" });
  });

  it("closes live connections whose session ended, within the sweep interval", async () => {
    const config = { ...testConfig, cluster: "postgres" as const, databaseUrl: inject("databaseUrl") };
    const b = await testApp({ db: t.db, config, liveRevalidateMs: 100 });
    copies.push(b);
    const admin = await setupAdmin(b);
    const ed = await createUser(b, admin, { email: "ed@example.com", name: "Ed", role: "editor" });
    const onB = await connect(b, ed.cookie);
    await t.db.session.deleteMany({ where: { user: { email: "ed@example.com" } } }); // signed out elsewhere, nobody told B
    expect(await onB.closed).toBe(CLOSE_SESSION_ENDED);
  });
});

describe("several copies: access checks on open connections", () => {
  it("closes a board connection once its person may no longer see the board, even after a rejected command", async () => {
    const config = { ...testConfig, cluster: "postgres" as const, databaseUrl: inject("databaseUrl") };
    const b = await testApp({ db: t.db, config, liveRevalidateMs: 100 });
    copies.push(b);
    const admin = await setupAdmin(b);
    const ed = await createUser(b, admin, { email: "ed@example.com", name: "Ed", role: "editor" });
    const projectId = (await b.inject({ method: "POST", url: "/api/projects", headers: { cookie: ed.cookie }, payload: { name: "Launch" } })).json().project.id as string;
    const onB = await connect(b, ed.cookie);
    onB.send({ type: "join", projectId, version: 0 });
    await onB.next("joined");
    await t.db.user.update({ where: { email: "ed@example.com" }, data: { role: "guest" } }); // demoted, nobody told B
    onB.send({ type: "command", commandId: randomUUID(), command: createTask("Sneaky") });
    await onB.next("reject"); // refreshes the connection's view of Ed …
    expect(await onB.closed).toBe(CLOSE_SESSION_ENDED); // … and the sweep still closes it
  });
});
