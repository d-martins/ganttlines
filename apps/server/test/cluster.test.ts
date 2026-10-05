import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, inject, it } from "vitest";
import { createUser, setupAdmin, testApp, testConfig, useTestApp } from "./helpers";

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
