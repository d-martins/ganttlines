import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUser, setupAdmin, testApp, testConfig, useTestApp } from "./helpers";

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

/** The project as a fresh server (empty cache) reads it back from the database. */
async function reload(cookie: string, projectId: string) {
  const restarted = await testApp({ db: t.db, config: testConfig, now: () => t.clock.now });
  const state = (await restarted.inject({ url: `/api/projects/${projectId}/state`, headers: { cookie } })).json();
  await restarted.close();
  return state;
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

afterEach(() => vi.restoreAllMocks());

/**
 * Records the Row and Link writes the server issues inside transactions, in order, each with the
 * number of the transaction it ran in.
 */
function recordWrites() {
  const writes: { transaction: number; call: string; args: unknown }[] = [];
  const transaction = t.db.$transaction.bind(t.db) as (work: unknown, options?: unknown) => Promise<unknown>;
  let count = 0;
  vi.spyOn(t.db, "$transaction").mockImplementation(((work: unknown, options?: unknown) => {
    if (typeof work !== "function") return transaction(work, options);
    const number = ++count;
    const watch = (tx: object) =>
      new Proxy(tx, {
        get(target, model, receiver) {
          const delegate = Reflect.get(target, model, receiver) as Record<string, unknown>;
          if (model !== "row" && model !== "link") return delegate;
          return new Proxy(delegate, {
            get(methods, method) {
              const fn = Reflect.get(methods, method) as (...args: unknown[]) => unknown;
              if (typeof fn !== "function" || typeof method !== "string") return fn;
              return (...args: unknown[]) => {
                writes.push({ transaction: number, call: `${model}.${method}`, args: args[0] });
                return fn.apply(methods, args);
              };
            },
          });
        },
      });
    return transaction((tx: object) => (work as (tx: object) => unknown)(watch(tx)), options);
  }) as never);
  return writes;
}

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
    const restarted = await testApp({ db: t.db, config: testConfig, now: () => t.clock.now });
    const reloaded = (await restarted.inject({ url: `/api/projects/${projectId}/state`, headers: { cookie: editor } })).json();
    await restarted.close();
    expect(reloaded).toEqual(state);
  });

  it("stores half-day durations and actual work days", async () => {
    const { editor, projectId } = await editorWithProject();
    const id = randomUUID();
    await send(editor, projectId, createTask(id, "Build", "2026-10-05"));
    expect((await send(editor, projectId, { type: "setDuration", id, duration: 2.5 })).statusCode).toBe(200);
    expect((await send(editor, projectId, { type: "setActualDuration", id, days: 3.5 })).statusCode).toBe(200);
    expect((await send(editor, projectId, { type: "setDuration", id, duration: 1.25 })).statusCode).toBe(400);

    // A fresh server (empty cache) reads them back from the database.
    const restarted = await testApp({ db: t.db, config: testConfig, now: () => t.clock.now });
    const reloaded = (await restarted.inject({ url: `/api/projects/${projectId}/state`, headers: { cookie: editor } })).json();
    await restarted.close();
    expect(reloaded.rows).toEqual([expect.objectContaining({ id, duration: 2.5, actualDuration: 3.5 })]);
  });

  it("stores afternoon starts and half-day lags", async () => {
    const { editor, projectId } = await editorWithProject();
    const [a, b] = [randomUUID(), randomUUID()];
    await send(editor, projectId, createTask(a, "Design", "2026-10-05"));
    await send(editor, projectId, createTask(b, "Build", "2026-10-05"));
    expect((await send(editor, projectId, { type: "moveTask", id: a, start: "2026-10-05", half: "afternoon" })).statusCode).toBe(200);
    expect((await send(editor, projectId, { type: "addLink", predecessorId: a, followerId: b, kind: "FS" })).statusCode).toBe(200);
    expect((await send(editor, projectId, { type: "updateLink", predecessorId: a, followerId: b, kind: "FS", lag: 0.5 })).statusCode).toBe(200);

    const reloaded = await reload(editor, projectId);
    expect(reloaded.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: a, userStart: "2026-10-05", startsAfternoon: true }),
        // a ends Tue 6 midday; b starts that afternoon, plus half a day: Wed 7 morning
        expect.objectContaining({ id: b, userStart: "2026-10-07", startsAfternoon: false }),
      ]),
    );
    expect(reloaded.links).toEqual([{ predecessorId: a, followerId: b, kind: "FS", lag: 0.5 }]);
  });

  it("addLink over REST persists the link; reloading the project from the database shows it", async () => {
    const { editor, projectId } = await editorWithProject();
    const [a, b] = [randomUUID(), randomUUID()];
    await send(editor, projectId, createTask(a, "Design", "2026-10-05"));
    await send(editor, projectId, createTask(b, "Build", "2026-10-05"));
    const added = await send(editor, projectId, { type: "addLink", predecessorId: a, followerId: b, kind: "SS", lag: 1 });
    expect(added.statusCode).toBe(200);
    expect(added.json().changes).toContainEqual({ link: { predecessorId: a, followerId: b, kind: "SS" }, field: "*", before: null, after: { predecessorId: a, followerId: b, kind: "SS", lag: 1 } });
    const live = (await t.app.inject({ url: `/api/projects/${projectId}/state`, headers: { cookie: editor } })).json();
    expect(live.links).toEqual([{ predecessorId: a, followerId: b, kind: "SS", lag: 1 }]);
    expect(await t.db.link.findMany({ where: { projectId } })).toEqual([{ projectId, predecessorId: a, followerId: b, kind: "SS", lag: 1 }]);
    expect(await reload(editor, projectId)).toEqual(live);
  });

  it("addLink SF persists and reloads", async () => {
    const { editor, projectId } = await editorWithProject();
    const [a, b] = [randomUUID(), randomUUID()];
    await send(editor, projectId, createTask(a, "Design", "2026-10-05"));
    await send(editor, projectId, createTask(b, "Build", "2026-10-12"));
    const added = await send(editor, projectId, { type: "addLink", predecessorId: a, followerId: b, kind: "SF", lag: 1 });
    expect(added.statusCode, added.body).toBe(200);
    expect(await t.db.link.findMany({ where: { projectId } })).toEqual([{ projectId, predecessorId: a, followerId: b, kind: "SF", lag: 1 }]);
    expect((await reload(editor, projectId)).links).toEqual([{ predecessorId: a, followerId: b, kind: "SF", lag: 1 }]);
  });

  it("updateLink reverse persists as one log entry, and undo restores", async () => {
    const { editor, projectId } = await editorWithProject();
    const [a, b] = [randomUUID(), randomUUID()];
    await send(editor, projectId, createTask(a, "Design", "2026-10-05"));
    await send(editor, projectId, createTask(b, "Build", "2026-10-12"));
    await send(editor, projectId, { type: "addLink", predecessorId: a, followerId: b, kind: "FS" });
    const logged = () => t.db.commandLog.count({ where: { projectId } });
    const before = await logged();
    const turned = await send(editor, projectId, { type: "updateLink", predecessorId: a, followerId: b, kind: "FS", reverse: true });
    expect(turned.statusCode, turned.body).toBe(200);
    expect(await logged()).toBe(before + 1);
    expect(await t.db.link.findMany({ where: { projectId } })).toEqual([{ projectId, predecessorId: b, followerId: a, kind: "FS", lag: 0 }]);
    const undo = await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/undo`, headers: { cookie: editor }, payload: { commandId: randomUUID() } });
    expect(undo.json()).toMatchObject({ skipped: 0 });
    expect(await t.db.link.findMany({ where: { projectId } })).toEqual([{ projectId, predecessorId: a, followerId: b, kind: "FS", lag: 0 }]);
  });

  it("changes a link's lag and kind, and removes it, in the database", async () => {
    const { editor, projectId } = await editorWithProject();
    const [a, b] = [randomUUID(), randomUUID()];
    await send(editor, projectId, createTask(a, "Design", "2026-10-05"));
    await send(editor, projectId, createTask(b, "Build", "2026-10-05"));
    await send(editor, projectId, { type: "addLink", predecessorId: a, followerId: b, kind: "FS" });
    expect((await send(editor, projectId, { type: "updateLink", predecessorId: a, followerId: b, kind: "FS", lag: 2 })).statusCode).toBe(200);
    expect(await t.db.link.findMany({ where: { projectId } })).toEqual([expect.objectContaining({ kind: "FS", lag: 2 })]);
    expect((await send(editor, projectId, { type: "updateLink", predecessorId: a, followerId: b, kind: "FS", newKind: "FF" })).statusCode).toBe(200);
    expect(await t.db.link.findMany({ where: { projectId } })).toEqual([expect.objectContaining({ kind: "FF", lag: 2 })]);
    expect((await reload(editor, projectId)).links).toEqual([{ predecessorId: a, followerId: b, kind: "FF", lag: 2 }]);
    expect((await send(editor, projectId, { type: "removeLink", predecessorId: a, followerId: b, kind: "FF" })).statusCode).toBe(200);
    expect(await t.db.link.count({ where: { projectId } })).toBe(0);
    expect((await reload(editor, projectId)).links).toEqual([]);
  });

  it("deleting a task removes its links in the database too", async () => {
    const { editor, projectId } = await editorWithProject();
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of [a, b, c]) await send(editor, projectId, createTask(id, "T", "2026-10-05"));
    await send(editor, projectId, { type: "addLink", predecessorId: a, followerId: b, kind: "FS" });
    await send(editor, projectId, { type: "addLink", predecessorId: b, followerId: c, kind: "FS" });
    await send(editor, projectId, { type: "addLink", predecessorId: a, followerId: c, kind: "SS" });
    const writes = recordWrites();
    const deleted = await send(editor, projectId, { type: "deleteRows", ids: [b] });
    expect(deleted.statusCode).toBe(200);
    // The links are deleted by name before the row, so the database's cascade has nothing left to do.
    const deletes = writes.filter(({ call }) => call.endsWith(".deleteMany"));
    expect(deletes.map(({ call }) => call)).toEqual(["link.deleteMany", "row.deleteMany"]);
    expect((deletes[0]!.args as { where: { OR: unknown[] } }).where.OR).toEqual(
      expect.arrayContaining([
        { predecessorId: a, followerId: b, kind: "FS" },
        { predecessorId: b, followerId: c, kind: "FS" },
      ]),
    );
    expect(await t.db.link.findMany({ where: { projectId } })).toEqual([expect.objectContaining({ predecessorId: a, followerId: c, kind: "SS" })]);
    expect((await reload(editor, projectId)).links).toEqual([expect.objectContaining({ predecessorId: a, followerId: c, kind: "SS" })]);
  });

  it("undo of a delete re-creates the rows and their links in one transaction", async () => {
    const { editor, projectId } = await editorWithProject();
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of [a, b, c]) await send(editor, projectId, createTask(id, "T", "2026-10-05"));
    await send(editor, projectId, { type: "addLink", predecessorId: a, followerId: b, kind: "FS" });
    await send(editor, projectId, { type: "addLink", predecessorId: b, followerId: c, kind: "SS", lag: 1 });
    const before = await reload(editor, projectId);
    await send(editor, projectId, { type: "deleteRows", ids: [b] });
    const writes = recordWrites();
    const undo = await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/undo`, headers: { cookie: editor }, payload: { commandId: randomUUID() } });
    expect(undo.json()).toMatchObject({ skipped: 0 });
    const creates = writes.filter(({ call }) => call.endsWith(".createMany"));
    expect(creates.map(({ call }) => call)).toEqual(["row.createMany", "link.createMany"]);
    expect(new Set(creates.map(({ transaction }) => transaction)).size).toBe(1);
    expect(await t.db.link.count({ where: { projectId } })).toBe(2);
    const after = await reload(editor, projectId);
    expect(after.links).toEqual(expect.arrayContaining(before.links));
    expect(after.links).toHaveLength(2);
    const byId = (rows: { id: string }[]) => [...rows].sort((x, y) => (x.id < y.id ? -1 : 1));
    expect(byId(after.rows)).toEqual(byId(before.rows));
  });

  it("undo of addLink deletes the row in the Link table", async () => {
    const { editor, projectId } = await editorWithProject();
    const [a, b] = [randomUUID(), randomUUID()];
    await send(editor, projectId, createTask(a, "Design", "2026-10-05"));
    await send(editor, projectId, createTask(b, "Build", "2026-10-05"));
    await send(editor, projectId, { type: "addLink", predecessorId: a, followerId: b, kind: "FS" });
    expect(await t.db.link.count({ where: { projectId } })).toBe(1);
    const undo = await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/undo`, headers: { cookie: editor }, payload: { commandId: randomUUID() } });
    expect(undo.json()).toMatchObject({ skipped: 0 });
    expect(await t.db.link.count({ where: { projectId } })).toBe(0);
    const redo = await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/redo`, headers: { cookie: editor }, payload: { commandId: randomUUID() } });
    expect(redo.json()).toMatchObject({ skipped: 0 });
    expect((await reload(editor, projectId)).links).toEqual([{ predecessorId: a, followerId: b, kind: "FS", lag: 0 }]);
  });

  it("a project whose stored link joins a task to its parent loads as corrupt", async () => {
    const { editor, projectId } = await editorWithProject();
    const [parent, child] = [randomUUID(), randomUUID()];
    await send(editor, projectId, createTask(parent, "Parent", "2026-10-05"));
    await send(editor, projectId, { type: "createRow", id: child, kind: "task", parentId: parent, afterId: null, title: "Child", start: "2026-10-05" });
    await t.db.link.create({ data: { projectId, predecessorId: parent, followerId: child, kind: "FS", lag: 0 } });
    const restarted = await testApp({ db: t.db, config: testConfig, now: () => t.clock.now });
    const response = await restarted.inject({ url: `/api/projects/${projectId}/state`, headers: { cookie: editor } });
    await restarted.close();
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toBe("project_corrupt");
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

describe("tags", () => {
  it("stores tags, spelled as the workspace first spelled them", async () => {
    const { editor, projectId } = await editorWithProject();
    const other = (await t.app.inject({ method: "POST", url: "/api/projects", headers: { cookie: editor }, payload: { name: "Other" } })).json().project.id as string;
    const first = randomUUID();
    await send(editor, other, createTask(first, "Elsewhere"));
    expect((await send(editor, other, { type: "setTags", id: first, tags: ["UI", "Back end"] })).statusCode).toBe(200);

    const id = randomUUID();
    await send(editor, projectId, createTask(id));
    const response = await send(editor, projectId, { type: "setTags", id, tags: ["ui", " new ", "back END"] });
    expect(response.statusCode).toBe(200);
    expect(response.json().changes).toEqual([expect.objectContaining({ rowId: id, field: "tags", after: ["UI", "new", "Back end"] })]);
    const row = (await reload(editor, projectId)).rows.find((r: { id: string }) => r.id === id);
    expect(row.tags).toEqual(["UI", "new", "Back end"]);
  });

  it("keeps a target through a reload, and undoes creating one as a single step", async () => {
    const { editor, projectId } = await editorWithProject();
    const id = randomUUID();
    const milestone = randomUUID();
    await send(editor, projectId, createTask(id));
    expect((await send(editor, projectId, { type: "createTargetMilestone", id, newId: milestone, title: "8.12", parentId: null, afterId: null, start: "2026-11-17" })).statusCode).toBe(200);
    const rowOf = async (rowId: string) => (await reload(editor, projectId)).rows.find((r: { id: string }) => r.id === rowId);
    expect(await rowOf(id)).toMatchObject({ targetId: milestone });
    expect(await rowOf(milestone)).toMatchObject({ duration: 0, title: "8.12", userStart: "2026-11-17" });
    expect((await send(editor, projectId, { type: "setTarget", id, targetId: null })).statusCode).toBe(200);
    expect(await rowOf(id)).toMatchObject({ targetId: null });
  });

  it("turns an aim into a link as one entry, and one undo restores the aim", async () => {
    const { editor, projectId } = await editorWithProject();
    const id = randomUUID();
    const milestone = randomUUID();
    await send(editor, projectId, createTask(id, "Task", "2026-11-02"));
    await send(editor, projectId, { type: "createTargetMilestone", id, newId: milestone, title: "8.12", parentId: null, afterId: null, start: "2026-11-17" });
    const relinked = await send(editor, projectId, {
      type: "relink",
      steps: [
        { type: "setTarget", id, targetId: null },
        { type: "addLink", predecessorId: id, followerId: milestone, kind: "FS" },
      ],
    });
    expect(relinked.statusCode).toBe(200);
    expect(await reload(editor, projectId)).toMatchObject({ links: [{ predecessorId: id, followerId: milestone, kind: "FS" }] });
    const undo = await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/undo`, headers: { cookie: editor }, payload: { commandId: randomUUID() } });
    expect(undo.json()).toMatchObject({ skipped: 0 });
    const after = await reload(editor, projectId);
    expect(after.links).toEqual([]);
    expect(after.rows.find((r: { id: string }) => r.id === id)).toMatchObject({ targetId: milestone });
  });

  it("matches spellings only within the board for share-link editors, so other projects' tags stay hidden", async () => {
    const { admin, editor, projectId } = await editorWithProject();
    const secret = (await t.app.inject({ method: "POST", url: "/api/projects", headers: { cookie: editor }, payload: { name: "Secret" } })).json().project.id as string;
    const hidden = randomUUID();
    await send(editor, secret, createTask(hidden));
    await send(editor, secret, { type: "setTags", id: hidden, tags: ["Secret Launch"] });
    const id = randomUUID();
    await send(editor, projectId, createTask(id));
    await send(editor, projectId, { type: "setTags", id, tags: ["Board tag"] });
    const tagsOf = async () => (await reload(editor, projectId)).rows.find((r: { id: string }) => r.id === id).tags;
    const viaLink = (headers: Record<string, string>, tags: string[]) =>
      t.app.inject({ method: "POST", url: `/api/projects/${projectId}/commands`, headers, payload: { commandId: randomUUID(), command: { type: "setTags", id, tags } } });

    // An anonymous visitor on a collaborative link.
    const anonymous = (await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/share-links`, headers: { cookie: admin }, payload: { access: "anonymous", collaboration: true } })).json().token as string;
    const visit = await t.app.inject({ method: "POST", url: `/api/share/${anonymous}/visitor`, payload: { name: "Rudy" } });
    const visitor = { "x-share-token": anonymous, cookie: `gp_visitor=${visit.cookies.find((c) => c.name === "gp_visitor")!.value}` };
    expect((await viaLink(visitor, ["secret launch", "board TAG"])).statusCode).toBe(200);
    expect(await tagsOf()).toEqual(["secret launch", "Board tag"]);

    // Signed-in guests and viewers who edit through a collaborative link: the board's own spelling, never the other project's.
    const signedIn = (await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/share-links`, headers: { cookie: admin }, payload: { access: "authenticated", collaboration: true } })).json().token as string;
    for (const role of ["guest", "viewer"] as const) {
      const user = await createUser(t.app, admin, { email: `${role}@example.com`, name: role, role });
      expect((await viaLink({ "x-share-token": signedIn, cookie: user.cookie }, ["SECRET launch", role])).statusCode, role).toBe(200);
      expect(await tagsOf(), role).toEqual(["secret launch", role]);
    }

    // An editor sees the whole workspace anyway (once this board no longer spells it its own way).
    await send(editor, projectId, { type: "setTags", id, tags: [] });
    await send(editor, projectId, { type: "setTags", id, tags: ["secret launch"] });
    expect(await tagsOf()).toEqual(["Secret Launch"]);
  });

  it("refuses tags on sections, and keeps a section's description", async () => {
    const { editor, projectId } = await editorWithProject();
    const id = randomUUID();
    await send(editor, projectId, { ...createTask(id, "Phase"), kind: "section" });
    expect((await send(editor, projectId, { type: "setTags", id, tags: ["UI"] })).json()).toMatchObject({ message: "Sections have no tags" });
    expect((await send(editor, projectId, { type: "setDescription", id, description: "What this phase is for" })).statusCode).toBe(200);
    const row = (await reload(editor, projectId)).rows.find((r: { id: string }) => r.id === id);
    expect(row).toMatchObject({ kind: "section", description: "What this phase is for" });
    expect(row.tags).toBeUndefined();
  });

  it("answers a retried setTags with its first outcome", async () => {
    const { editor, projectId } = await editorWithProject();
    const id = randomUUID();
    await send(editor, projectId, createTask(id));
    await send(editor, projectId, { type: "setTags", id, tags: ["UI"] });
    const commandId = randomUUID();
    const first = await send(editor, projectId, { type: "setTags", id, tags: ["ui", "x"] }, commandId);
    const again = await send(editor, projectId, { type: "setTags", id, tags: ["ui", "x"] }, commandId);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
  });
});

describe("robustness", () => {
  it("recovers when the database moved on without the server (stale cache)", async () => {
    const { editor, projectId } = await editorWithProject();
    await send(editor, projectId, createTask(randomUUID()));
    await t.db.project.update({ where: { id: projectId }, data: { version: 7 } });
    const stale = await send(editor, projectId, createTask(randomUUID()));
    if (testConfig.cluster === "postgres") {
      // With several copies, a board is checked against the database first (and reloaded).
      expect(stale.json().version).toBe(8);
      return;
    }
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
    const fresh = await testApp({ db: t.db, config: testConfig, now: () => t.clock.now });
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
