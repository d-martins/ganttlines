import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createUser, setupAdmin, useTestApp } from "./helpers";

const t = useTestApp();

async function twoEditorsWithProject() {
  const admin = await setupAdmin(t.app);
  const ana = (await createUser(t.app, admin, { email: "ana@example.com", name: "Ana", role: "editor" })).cookie;
  const rudy = (await createUser(t.app, admin, { email: "rudy@example.com", name: "Rudy", role: "editor" })).cookie;
  const project = (await t.app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ana }, payload: { name: "Launch" } })).json().project;
  return { ana, rudy, projectId: project.id as string };
}

const send = (cookie: string, projectId: string, command: object, commandId: string = randomUUID()) =>
  t.app.inject({ method: "POST", url: `/api/projects/${projectId}/commands`, headers: { cookie }, payload: { commandId, command } });
const undo = (cookie: string, projectId: string) =>
  t.app.inject({ method: "POST", url: `/api/projects/${projectId}/undo`, headers: { cookie }, payload: { commandId: randomUUID() } });
const redo = (cookie: string, projectId: string) =>
  t.app.inject({ method: "POST", url: `/api/projects/${projectId}/redo`, headers: { cookie }, payload: { commandId: randomUUID() } });
const rows = async (cookie: string, projectId: string) =>
  (await t.app.inject({ url: `/api/projects/${projectId}/state`, headers: { cookie } })).json().rows as { id: string; title: string }[];
const createTask = (id: string, title = "Task") => ({ type: "createRow", id, kind: "task", parentId: null, afterId: null, title });

describe("undo and redo", () => {
  it("undoes and redoes the user's own last change as new versions", async () => {
    const { ana, projectId } = await twoEditorsWithProject();
    const id = randomUUID();
    await send(ana, projectId, createTask(id, "Design"));
    await send(ana, projectId, { type: "updateTitle", id, title: "Build" });
    const undone = await undo(ana, projectId);
    expect(undone.json()).toMatchObject({ version: 3, skipped: 0, changes: [{ rowId: id, field: "title", before: "Build", after: "Design" }] });
    expect((await rows(ana, projectId))[0]!.title).toBe("Design");
    expect((await redo(ana, projectId)).json()).toMatchObject({ version: 4, skipped: 0 });
    expect((await rows(ana, projectId))[0]!.title).toBe("Build");
  });

  it("only undoes your own changes", async () => {
    const { ana, rudy, projectId } = await twoEditorsWithProject();
    await send(ana, projectId, createTask(randomUUID(), "Ana's"));
    await send(rudy, projectId, createTask(randomUUID(), "Rudy's"));
    await undo(ana, projectId);
    expect((await rows(ana, projectId)).map((row) => row.title)).toEqual(["Rudy's"]);
  });

  it("skips values someone else changed since", async () => {
    const { ana, rudy, projectId } = await twoEditorsWithProject();
    const id = randomUUID();
    await send(ana, projectId, createTask(id, "Design"));
    await send(ana, projectId, { type: "setDuration", id, duration: 3 });
    await send(ana, projectId, { type: "updateTitle", id, title: "Build" });
    await send(rudy, projectId, { type: "updateTitle", id, title: "Rudy's title" });
    await undo(ana, projectId); // Ana's rename: Rudy changed the title since → skipped
    const response = await undo(ana, projectId); // Ana's duration change: untouched → undone
    expect(response.json()).toMatchObject({ skipped: 0, changes: [{ field: "duration", after: 1 }] });
  });

  it("reports when nothing is left to undo", async () => {
    const { ana, rudy, projectId } = await twoEditorsWithProject();
    const id = randomUUID();
    await send(ana, projectId, createTask(id, "Design"));
    await send(ana, projectId, { type: "updateTitle", id, title: "Build" });
    await send(rudy, projectId, { type: "updateTitle", id, title: "Rudy's title" });
    const conflictResponse = await undo(ana, projectId);
    expect(conflictResponse.statusCode).toBe(409);
    const empty = await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/redo`, headers: { cookie: ana }, payload: { commandId: randomUUID() } });
    expect(empty.statusCode).toBe(422);
  });

  it("refuses an undo that would break the task tree", async () => {
    const { ana, rudy, projectId } = await twoEditorsWithProject();
    const [parent, child] = [randomUUID(), randomUUID()];
    await send(rudy, projectId, createTask(parent, "Parent"));
    await send(ana, projectId, { ...createTask(child, "Child"), parentId: parent });
    await send(ana, projectId, { type: "deleteRows", ids: [child] });
    await send(rudy, projectId, { type: "deleteRows", ids: [parent] });
    expect((await undo(ana, projectId)).statusCode).toBe(409); // re-creating the child needs its deleted parent
  });

  it("clears redo when a new change is made", async () => {
    const { ana, projectId } = await twoEditorsWithProject();
    await send(ana, projectId, createTask(randomUUID(), "A"));
    await undo(ana, projectId);
    await send(ana, projectId, createTask(randomUUID(), "B"));
    expect((await redo(ana, projectId)).statusCode).toBe(422);
  });
});

describe("retried commands", () => {
  it("answer rejections and no-ops the same way even after the board changed", async () => {
    const { ana, rudy, projectId } = await twoEditorsWithProject();
    const id = randomUUID();
    await send(ana, projectId, createTask(id, "Same"));
    const noopId = randomUUID();
    const noop = await send(ana, projectId, { type: "updateTitle", id, title: "Same" }, noopId);
    await send(rudy, projectId, { type: "updateTitle", id, title: "Rudy's" });
    const retried = await send(ana, projectId, { type: "updateTitle", id, title: "Same" }, noopId);
    expect(retried.json()).toEqual(noop.json());
    expect((await rows(ana, projectId))[0]!.title).toBe("Rudy's");

    const rejectedId = randomUUID();
    const rejected = await send(ana, projectId, { type: "indent", id }, rejectedId);
    expect(rejected.statusCode).toBe(422);
    await send(ana, projectId, { ...createTask(randomUUID(), "Before"), afterId: null });
    expect((await send(ana, projectId, { type: "indent", id }, rejectedId)).statusCode).toBe(422);
  });
});
