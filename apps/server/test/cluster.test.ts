import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, inject, it } from "vitest";
import { PgLimiter } from "../src/auth/limiter";
import { createCluster } from "../src/cluster";
import { PgUndoStore } from "../src/projects/undo-store";
import { expectUndoHistory } from "./undo-history";
import type { Cluster, EventBus } from "../src/cluster/types";
import { CLOSE_PROJECT_DELETED, CLOSE_SESSION_ENDED } from "../src/realtime/hub";
import { buildApp } from "../src/app";
import { ADMIN, createUser, SETUP_CODE, setupAdmin, testApp, testConfig, useTestApp } from "./helpers";
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
    const b = await testApp({ db: t.db, config, liveRevalidateMs: 1000 }); // long enough for the command to be answered first
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

describe("several copies: a lost notification has a backstop", () => {
  it("uses the current team calendar even if the copy never heard it changed", async () => {
    const { b, admin } = await twoCopies();
    await b.inject({ url: "/api/calendar", headers: { cookie: admin } }); // B caches the calendar
    await t.db.holiday.create({ data: { name: "Surprise day", startDate: "2026-10-09", endDate: "2026-10-09", appliesToAll: true, resourceIds: [] } });
    await t.db.settings.update({ where: { id: 1 }, data: { instanceVersion: { increment: 1 } } }); // changed, nobody told B
    const calendar = (await b.inject({ url: "/api/calendar", headers: { cookie: admin } })).json();
    expect(calendar.holidays.map((h: { name: string }) => h.name)).toContain("Surprise day");
  });
});

describe("several copies: board changes are announced by the edit's own transaction", () => {
  it("reaches the other copies even if sending a notification afterwards fails", async () => {
    const config = { ...testConfig, cluster: "postgres" as const, databaseUrl: inject("databaseUrl") };
    const real = await createCluster(config, () => undefined);
    // A copy whose notifications sent after the fact all get lost.
    const lossy: Cluster = { ...real, bus: Object.assign(Object.create(real.bus) as EventBus, { publish: async () => undefined }) };
    const a = await testApp({ db: t.db, config, cluster: lossy });
    const b = await testApp({ db: t.db, config });
    copies.push(a, b);
    const admin = await setupAdmin(a);
    const projectId = (await a.inject({ method: "POST", url: "/api/projects", headers: { cookie: admin }, payload: { name: "Launch" } })).json().project.id as string;
    const onB = await connect(b, admin);
    onB.send({ type: "join", projectId, version: 0 });
    await onB.next("joined");
    await command(a, admin, projectId, createTask("Design"));
    expect((await onB.next("patch")).version).toBe(1);
    onB.ws.close();
  });
});

describe("several copies: undo", () => {
  it("keeps the same bounded histories in the database as in memory", async () => {
    const { projectId } = await twoCopies();
    await expectUndoHistory(new PgUndoStore(t.db, 2), projectId);
  });

  it("undoes an edit made through the other copy", async () => {
    const { a, b, ed, projectId } = await twoCopies();
    await command(a, ed.cookie, projectId, createTask("Design"));
    const undo = await b.inject({ method: "POST", url: `/api/projects/${projectId}/undo`, headers: { cookie: ed.cookie }, payload: { commandId: randomUUID() } });
    expect(undo.statusCode).toBe(200);
    expect((await state(a, ed.cookie, projectId)).rows).toEqual([]);
    const redo = await a.inject({ method: "POST", url: `/api/projects/${projectId}/redo`, headers: { cookie: ed.cookie }, payload: { commandId: randomUUID() } });
    expect(redo.statusCode).toBe(200);
    expect((await state(b, ed.cookie, projectId)).rows.map((row) => row.title)).toEqual(["Design"]);
  });
});

describe("several copies: rate limits", () => {
  it("counts failed sign-ins on every copy together (keys stored hashed)", async () => {
    const { a, b } = await twoCopies();
    const wrong = (app: FastifyInstance) => app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ed@example.com", password: "wrong" } });
    for (let i = 0; i < 10; i++) await wrong(i % 2 ? b : a);
    expect((await wrong(a)).statusCode).toBe(429);
    expect((await wrong(b)).statusCode).toBe(429);
    expect(await t.db.rateCounter.count({ where: { key: { contains: "ed@example.com" } } })).toBe(0);
  });
});

describe("several copies: the setup code", () => {
  it("is printed by every copy and accepted on any", async () => {
    const config = { ...testConfig, cluster: "postgres" as const, databaseUrl: inject("databaseUrl") };
    const said: string[] = [];
    await t.db.settings.updateMany({ data: { setupCode: null } }); // the suite's own app may have stored its code
    const a = await buildApp({ db: t.db, config, announce: (message) => said.push(`a: ${message}`) });
    copies.push(a);
    const b = await buildApp({ db: t.db, config, announce: (message) => said.push(`b: ${message}`) });
    copies.push(b);
    await a.inject("/api/setup");
    await b.inject("/api/setup");
    const codes = said.map((line) => /setup code: (\S+)$/.exec(line)?.[1]);
    expect(codes).toEqual([expect.any(String), codes[0]]); // the same code, from both
    expect((await b.inject({ method: "POST", url: "/api/setup", payload: { ...ADMIN, setupCode: codes[0] } })).statusCode).toBe(201);
  });

  it("is printed again when every copy restarted before anyone set up", async () => {
    const config = { ...testConfig, cluster: "postgres" as const, databaseUrl: inject("databaseUrl") };
    await t.db.settings.updateMany({ data: { setupCode: null } });
    const said: string[] = [];
    const first = await buildApp({ db: t.db, config, announce: (message) => said.push(message) });
    await first.close();
    const again = await buildApp({ db: t.db, config, announce: (message) => said.push(message) });
    copies.push(again);
    const codes = said.map((line) => /setup code: (\S+)$/.exec(line)?.[1]);
    expect(codes).toEqual([expect.any(String), codes[0]]);
    expect((await again.inject({ method: "POST", url: "/api/setup", payload: { ...ADMIN, setupCode: codes[0] } })).statusCode).toBe(201);
  });

  it("is stored again by the copy that knows it if the database lost it", async () => {
    const config = { ...testConfig, cluster: "postgres" as const, databaseUrl: inject("databaseUrl") };
    const a = await testApp({ db: t.db, config });
    copies.push(a);
    await a.inject("/api/setup");
    await t.db.settings.deleteMany({}); // e.g. tests resetting the database
    expect((await a.inject({ method: "POST", url: "/api/setup", payload: { ...ADMIN, setupCode: SETUP_CODE } })).statusCode).toBe(201);
  });
});

describe("several copies: rate limit safeguards", () => {
  it("can't be dodged by straddling a window boundary", async () => {
    let now = 990;
    const limiter = new PgLimiter(t.db, "boundary", { windowMs: 1000, max: 10 }, () => now);
    for (let i = 0; i < 10; i++) await limiter.recordFailure(["ip:1"]);
    expect(await limiter.isBlocked(["ip:1"])).toBe(true);
    now = 1001; // a new window has just begun
    expect(await limiter.isBlocked(["ip:1"])).toBe(true);
    now = 2001; // a whole window later
    expect(await limiter.isBlocked(["ip:1"])).toBe(false);
  });

  it("never drops an account's attempts to make room, however full the table is", async () => {
    const limiter = new PgLimiter(t.db, "evict", { windowMs: 60_000, max: 10 }, Date.now, { maxKeys: 5, pruneEvery: 1000 });
    for (let k = 0; k < 8; k++) for (let i = 0; i < 9; i++) await limiter.recordFailure([`ip:flood-${k}`]); // busy keys fill the table
    for (let i = 0; i < 4; i++) await limiter.recordFailure(["user:target"]);
    await limiter.deleteOld(); // the table is over its cap: something is dropped …
    for (let i = 0; i < 6; i++) await limiter.recordFailure(["user:target"]);
    expect(await limiter.isBlocked(["user:target"])).toBe(true);
  });

  it("keeps the table bounded when other keys are busy too", async () => {
    const limiter = new PgLimiter(t.db, "busy", { windowMs: 60_000, max: 10 }, Date.now, { maxKeys: 5, pruneEvery: 1000 });
    for (let k = 0; k < 20; k++) for (let i = 0; i < 9; i++) await limiter.recordFailure([`ip:${k}`]);
    await limiter.deleteOld();
    expect(await t.db.rateCounter.count({ where: { key: { startsWith: "busy:" } } })).toBeLessThanOrEqual(5);
  });

  it("counts attempts as they start, so parallel ones (on any copy) can't get past the limit", async () => {
    const limiter = new PgLimiter(t.db, "parallel", { windowMs: 60_000, max: 10 });
    const allowed = await Promise.all(Array.from({ length: 30 }, () => limiter.attempt(["user:target"])));
    expect(allowed.filter(Boolean)).toHaveLength(10);
  });

  it("keeps the table bounded when flooded with distinct keys", async () => {
    const limiter = new PgLimiter(t.db, "flood", { windowMs: 60_000, max: 10 }, Date.now, { maxKeys: 20, pruneEvery: 10 });
    for (let i = 0; i < 200; i++) await limiter.recordFailure([`email:${i}@example.com`]);
    expect(await t.db.rateCounter.count({ where: { key: { startsWith: "flood:" } } })).toBeLessThanOrEqual(30);
  });
});

describe("several copies: stopping and readiness", () => {
  it("isn't ready without its listener; when stopping it says so, then tells browsers to reconnect elsewhere", async () => {
    const { a, ed } = await twoCopies();
    expect((await a.inject("/api/health")).json()).toEqual({ ok: true });
    await t.db.$executeRawUnsafe("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'ganttlines-listener'");
    let seen503 = false;
    for (let i = 0; i < 60; i++) {
      const health = await a.inject("/api/health");
      if (health.statusCode === 503) seen503 = true;
      else if (seen503) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(seen503).toBe(true); // not ready while the listener reconnects
    const onA = await connect(a, ed.cookie);
    a.drain();
    expect((await a.inject("/api/health")).json()).toEqual({ ok: false, reason: "stopping" });
    copies.splice(copies.indexOf(a), 1);
    await a.close();
    expect(await onA.closed).toBe(1001);
  });
});

describe("several copies: hardening", () => {
  it("checks idle connections without keeping their sessions alive", async () => {
    const config = { ...testConfig, cluster: "postgres" as const, databaseUrl: inject("databaseUrl") };
    const b = await testApp({ db: t.db, config, liveRevalidateMs: 100, now: () => t.clock.now });
    copies.push(b);
    const admin = await setupAdmin(b);
    const before = (await t.db.session.findFirstOrThrow()).expiresAt;
    const onB = await connect(b, admin);
    t.clock.now = new Date(t.clock.now.getTime() + 2 * 60 * 60 * 1000); // past the hourly sliding refresh
    await new Promise((resolve) => setTimeout(resolve, 400)); // a few checks
    expect((await t.db.session.findFirstOrThrow()).expiresAt).toEqual(before);
    onB.ws.close();
  });

  it("relays highlight lists in order on a third copy", async () => {
    const { a, b, ed, projectId } = await twoCopies();
    const config = { ...testConfig, cluster: "postgres" as const, databaseUrl: inject("databaseUrl") };
    const c = await testApp({ db: t.db, config });
    copies.push(c);
    const onC = await connect(c, ed.cookie);
    onC.send({ type: "join", projectId, version: 0 });
    await onC.next("joined");
    const add = (app: FastifyInstance, date: string) => app.inject({ method: "POST", url: `/api/projects/${projectId}/highlights`, headers: { cookie: ed.cookie }, payload: { date, color: "#ff0000" } });
    await Promise.all([add(a, "2026-10-09"), add(b, "2026-10-10")]);
    await onC.next("highlights", (m) => m.highlights.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(onC.inbox.filter((m) => m.type === "highlights").every((m) => (m as { highlights: unknown[] }).highlights.length === 2)).toBe(true);
    onC.ws.close();
  });
});
