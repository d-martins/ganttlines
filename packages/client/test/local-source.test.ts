import { describe, expect, it } from "vitest";
import { checkFormat, emptyWorkspace, toCalendarDto, type ProjectRecord } from "../src/local/records";
import { MemoryStore } from "../src/local/store";
import { validation } from "../src/local/validation";
import { fillWorkspace, workspaceContract } from "../testing/contract";
import { LocalSource } from "../src/local/local-source";
import { PROTOCOL_VERSION, type ServerMessage } from "@ganttlines/protocol";
import { TASK_DEFAULTS } from "@ganttlines/engine";

describe("local records", () => {
  it("starts empty, with Monday–Friday working days", async () => {
    expect(await new MemoryStore().load()).toEqual({ workspace: null, projects: [] });
    expect(toCalendarDto(emptyWorkspace())).toEqual({ instanceVersion: 1, workingWeekdays: [1, 2, 3, 4, 5], holidays: [], timeOff: [], locations: [] });
  });

  it("keeps copies, so later changes to an object don't leak into the store", async () => {
    const store = new MemoryStore();
    const workspace = emptyWorkspace();
    await store.saveWorkspace(workspace);
    workspace.workingWeekdays.push(6);
    expect((await store.load()).workspace?.workingWeekdays).toEqual([1, 2, 3, 4, 5]);
  });

  it("refuses other formats and newer versions", () => {
    expect(() => checkFormat({ format: "something-else", version: 1 })).toThrow(expect.objectContaining({ status: 400, code: "invalid_file" }));
    expect(() => checkFormat({ format: "ganttlines-workspace", version: 99 })).toThrow(expect.objectContaining({ status: 400, code: "newer_version" }));
    expect(() => checkFormat({ format: "ganttlines-workspace", version: 1 })).not.toThrow();
    expect(() => checkFormat({ format: "ganttlines-workspace", version: 2 })).not.toThrow();
    expect(() => checkFormat({ format: "ganttlines-workspace", version: 3 })).not.toThrow();
    expect(() => checkFormat({ format: "ganttlines-workspace", version: 4 })).not.toThrow();
    expect(() => checkFormat({ format: "ganttlines-workspace", version: 5 })).toThrow(expect.objectContaining({ code: "newer_version" }));
    expect(() => checkFormat({ format: "ganttlines-workspace", version: 1.5 })).toThrow(expect.objectContaining({ code: "invalid_file" }));
  });

  it("resolves a location holiday to the people in that location", () => {
    const workspace = emptyWorkspace();
    workspace.locations.push({ id: "l1", name: "Lisbon", country: null, region: null });
    workspace.team.push({ id: "r1", name: "Ana", avatarColor: "#4f8cff", inactive: false, locationId: "l1" });
    workspace.holidays.push({ id: "h1", name: "Fair", startDate: "2026-10-08", endDate: "2026-10-08", appliesToAll: false, resourceIds: [], locationIds: ["l1"] });
    expect(toCalendarDto(workspace).holidays).toEqual([
      { id: "h1", name: "Fair", startDate: "2026-10-08", endDate: "2026-10-08", appliesTo: ["r1"], target: { all: false, resourceIds: [], locationIds: ["l1"] } },
    ]);
  });

  it("checks request bodies with the protocol's schemas (loaded on demand)", async () => {
    const { protocol, check } = await validation();
    expect(check(protocol.CreateProjectBody, { name: "  Launch  " })).toEqual({ name: "Launch" });
    expect(() => check(protocol.CreateProjectBody, { name: "" })).toThrow(expect.objectContaining({ status: 400, code: "invalid_request" }));
  });
});

describe("the browser as a workspace source", () => {
  workspaceContract(async () => LocalSource.open(new MemoryStore()));
});

const contents = (source: LocalSource) => ({ ...source.exportFile(), exportedAt: "" });

describe("local workspace storage", () => {
  it("gives back everything — rows, baselines, calendar — when reopened", async () => {
    const store = new MemoryStore();
    const first = await LocalSource.open(store);
    await fillWorkspace(first);
    expect(contents(first).projects[0]?.rows).toHaveLength(1);
    expect(contents(await LocalSource.open(store))).toEqual(contents(first));
  });

  it("keeps everything for the next visit", async () => {
    const store = new MemoryStore();
    const first = await LocalSource.open(store);
    const project = await first.createProject({ name: "Launch" });
    const ana = await first.createResource({ name: "Ana" });
    await first.saveHoliday({ name: "Fair", startDate: "2026-10-08", endDate: "2026-10-08", appliesTo: [ana.id] });
    await first.saveHighlight(project.id, { date: "2026-10-09", label: "Demo", color: "#e5892f" });
    const again = await LocalSource.open(store);
    expect(await again.listProjects()).toEqual(await first.listProjects());
    expect(await again.calendar()).toEqual(await first.calendar());
    expect(await again.resources()).toEqual(await first.resources());
    expect(await again.highlights(project.id)).toEqual(await first.highlights(project.id));
  });

  it("says when every change asked for so far is stored", async () => {
    const store = new MemoryStore();
    const source = await LocalSource.open(store);
    void source.createProject({ name: "Launch" }); // the first change waits for the request checks to load
    void source.createProject({ name: "Garden" });
    await source.idle();
    expect((await store.load()).projects.map((project) => project.name).sort()).toEqual(["Garden", "Launch"]);
  });

  it("keeps working in memory when a change can't be saved, and says so", async () => {
    class FullStore extends MemoryStore {
      override async saveProject(): Promise<void> {
        throw new Error("QuotaExceededError");
      }
    }
    const errors: unknown[] = [];
    const source = await LocalSource.open(new FullStore(), { onStorageError: (error) => errors.push(error) });
    const project = await source.createProject({ name: "Launch" });
    expect(await source.listProjects()).toEqual([expect.objectContaining({ id: project.id })]);
    expect(errors).toHaveLength(1);
    expect(source.exportFile().projects).toEqual([expect.objectContaining({ id: project.id })]);
  });

  it("gives team members the next color in turn, and checks requests like the server", async () => {
    const source = await LocalSource.open(new MemoryStore());
    const colors = await Promise.all(["A", "B"].map(async (name) => (await source.createResource({ name })).avatarColor));
    expect(colors).toEqual(["#4f8cff", "#a66cff"]);
    await expect(source.createProject({ name: "" })).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await expect(source.updateResource("77777777-7777-4777-8777-777777777777", { name: "X" })).rejects.toMatchObject({ status: 404, message: "Team member not found" });
    await expect(source.setWorkingWeekdays([])).rejects.toMatchObject({ status: 400 });
  });
});

const TASK = "11111111-1111-4111-8111-111111111111";
const BUILD = "55555555-5555-4555-8555-555555555555";
const createDesign = (commandId: string) =>
  JSON.stringify({ type: "command", commandId, command: { type: "createRow", id: TASK, kind: "task", parentId: null, afterId: null, title: "Design", start: "2026-10-05" } });
/** Collects what a link receives; resolves once `count` messages arrived. */
function inbox(link: { onmessage: ((event: { data: unknown }) => void) | null }) {
  const messages: ServerMessage[] = [];
  link.onmessage = (event) => messages.push(JSON.parse(String(event.data)) as ServerMessage);
  return messages;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("local boards", () => {
  it("sends each change to every open board of the project, and the answer only to the sender", async () => {
    const source = await LocalSource.open(new MemoryStore());
    const project = await source.createProject({ name: "Launch" });
    const board = source.openBoard(project.id);
    const [a, b] = [board.openLink(), board.openLink()];
    const [toA, toB] = [inbox(a), inbox(b)];
    await settle();
    for (const link of [a, b]) link.send(JSON.stringify({ type: "join", projectId: project.id, version: 0, protocol: PROTOCOL_VERSION }));
    await settle();
    a.send(createDesign("22222222-2222-4222-8222-222222222222"));
    await settle();
    expect(toA.map((message) => message.type)).toEqual(["joined", "patch", "ack"]);
    expect(toB.map((message) => message.type)).toEqual(["joined", "patch"]);
  });

  it("starts each visit with an empty undo history", async () => {
    const store = new MemoryStore();
    const first = await LocalSource.open(store);
    const project = await first.createProject({ name: "Launch" });
    const link = first.openBoard(project.id).openLink();
    await settle();
    link.send(JSON.stringify({ type: "join", projectId: project.id, version: 0, protocol: PROTOCOL_VERSION }));
    link.send(createDesign("22222222-2222-4222-8222-222222222222"));
    await settle();
    const again = await LocalSource.open(store);
    const later = again.openBoard(project.id).openLink();
    const received = inbox(later);
    await settle();
    later.send(JSON.stringify({ type: "join", projectId: project.id, version: 1, protocol: PROTOCOL_VERSION }));
    later.send(JSON.stringify({ type: "undo", commandId: "33333333-3333-4333-8333-333333333333" }));
    await settle();
    expect(received).toContainEqual(expect.objectContaining({ type: "reject", message: "Nothing to undo" }));
    expect((await again.openBoard(project.id).load()).rows).toEqual([expect.objectContaining({ id: TASK })]);
  });

  it("local-source: addLink, undo, redo round-trip and persist links in the store", async () => {
    const store = new MemoryStore();
    const source = await LocalSource.open(store);
    const project = await source.createProject({ name: "Launch" });
    const link = source.openBoard(project.id).openLink();
    const received = inbox(link);
    await settle();
    link.send(JSON.stringify({ type: "join", projectId: project.id, version: 0, protocol: PROTOCOL_VERSION }));
    link.send(createDesign("22222222-2222-4222-8222-222222222222"));
    link.send(
      JSON.stringify({ type: "command", commandId: "44444444-4444-4444-8444-444444444444", command: { type: "createRow", id: BUILD, kind: "task", parentId: null, afterId: TASK, title: "Build", start: "2026-10-05" } }),
    );
    link.send(JSON.stringify({ type: "command", commandId: "66666666-6666-4666-8666-666666666666", command: { type: "addLink", predecessorId: TASK, followerId: BUILD, kind: "FS", lag: 0 } }));
    await settle();
    const fs = { predecessorId: TASK, followerId: BUILD, kind: "FS", lag: 0 };
    const stored = async () => (await store.load()).projects[0]?.links;
    expect((await source.openBoard(project.id).load()).links).toEqual([fs]);
    expect(await stored()).toEqual([fs]);
    expect(received).toContainEqual(expect.objectContaining({ type: "patch", changes: expect.arrayContaining([expect.objectContaining({ link: { predecessorId: TASK, followerId: BUILD, kind: "FS" } })]) }));

    link.send(JSON.stringify({ type: "undo", commandId: "77777777-7777-4777-8777-777777777777" }));
    await settle();
    expect((await source.openBoard(project.id).load()).links).toEqual([]);
    expect(await stored()).toEqual([]);

    link.send(JSON.stringify({ type: "redo", commandId: "88888888-8888-4888-8888-888888888888" }));
    await settle();
    expect(await stored()).toEqual([fs]);
    expect((await (await LocalSource.open(store)).openBoard(project.id).load()).links).toEqual([fs]);
    expect(received.filter((message) => message.type === "reject")).toEqual([]);
  });

  it("asks a board built for an older protocol to reload", async () => {
    const source = await LocalSource.open(new MemoryStore());
    const project = await source.createProject({ name: "Launch" });
    const link = source.openBoard(project.id).openLink();
    const closed = new Promise<number>((resolve) => (link.onclose = (event) => resolve(event.code)));
    await settle();
    link.send(JSON.stringify({ type: "join", projectId: project.id, version: 0 }));
    expect(await closed).toBe(1008);
  });

  it("opens a workspace stored by the previous version, its predecessors as links", async () => {
    const store = new MemoryStore();
    await store.saveWorkspace({ ...emptyWorkspace(), version: 1 });
    const row = (id: string, predecessorId: string | null, offset: number) => ({
      id, kind: "task", title: id, parentId: null, position: id === TASK ? "a0" : "a1", userStart: "2026-10-05", startsAfternoon: false, duration: 1, actualDuration: null,
      resourceId: null, color: "blue", locked: false, description: "", predecessorId, offset,
    });
    const project = { id: "66666666-6666-4666-8666-666666666666", name: "Old", archived: false, createdAt: "2026-10-01T00:00:00.000Z", version: 2, rows: [row(TASK, null, 0), row(BUILD, TASK, -0.5)], highlights: [], baselines: [] };
    await store.saveProject(project as unknown as ProjectRecord);
    const source = await LocalSource.open(store);
    const board = await source.openBoard(project.id).load();
    expect(board.links).toEqual([{ predecessorId: TASK, followerId: BUILD, kind: "FS", lag: -0.5 }]);
    expect(board.rows[1]).not.toHaveProperty("predecessorId");
    expect(source.exportFile().version).toBe(4);
    expect(board.rows.map((entry) => entry.kind === "task" && entry.tags)).toEqual([[], []]);

    // The next change writes the project back in the new shape.
    const link = source.openBoard(project.id).openLink();
    await settle();
    link.send(JSON.stringify({ type: "join", projectId: project.id, version: 2, protocol: PROTOCOL_VERSION }));
    link.send(JSON.stringify({ type: "command", commandId: "99999999-9999-4999-8999-999999999999", command: { type: "updateTitle", id: TASK, title: "Design" } }));
    await settle();
    const [stored] = (await store.load()).projects;
    expect(stored?.links).toEqual([{ predecessorId: TASK, followerId: BUILD, kind: "FS", lag: -0.5 }]);
    expect(stored?.rows.flatMap((row) => Object.keys(row)).filter((key) => key === "predecessorId" || key === "offset")).toEqual([]);
    expect(stored?.rows[0]).toMatchObject({ title: "Design" });
  });

  it("ends a deleted project's open boards", async () => {
    const source = await LocalSource.open(new MemoryStore());
    const project = await source.createProject({ name: "Launch" });
    const link = source.openBoard(project.id).openLink();
    const closed = new Promise<number>((resolve) => (link.onclose = (event) => resolve(event.code)));
    await settle();
    link.send(JSON.stringify({ type: "join", projectId: project.id, version: 0, protocol: PROTOCOL_VERSION }));
    await settle();
    await source.updateProject(project.id, { archived: true });
    await source.deleteProject(project.id);
    expect(await closed).toBe(4004);
  });
});

describe("local tags", () => {
  const OTHER = "77777777-7777-4777-8777-777777777777";
  const row = (id: string, position: string, tags: string[] | null) =>
    tags === null
      ? { id, kind: "section", title: "S", parentId: null, position, description: "" }
      : { ...TASK_DEFAULTS, id, kind: "task", title: "T", parentId: null, position, tags };
  const project = (id: string, name: string, createdAt: string, rows: unknown[]) => ({ id, name, archived: false, createdAt, version: 1, rows, links: [], highlights: [], baselines: [] }) as unknown as ProjectRecord;
  const ids = Array.from({ length: 8 }, (_, i) => `0000000${i}-0000-4000-8000-000000000000`);

  /** The same workspace as the server's tags test: "Other" is newer, and stored "ui" before the workspace knew "UI". */
  async function tagged() {
    const store = new MemoryStore();
    await store.saveWorkspace(emptyWorkspace());
    // Saved newest first: the order records come back in mustn't matter.
    await store.saveProject(project(OTHER, "Other", "2026-10-02T00:00:00.000Z", [row(ids[5]!, "a0", ["ui", "alpha"])]));
    await store.saveProject(
      project(TASK, "Launch", "2026-10-01T00:00:00.000Z", [row(ids[0]!, "a0", ["UI", "Back end"]), row(ids[1]!, "a1", ["UI"]), row(ids[2]!, "a2", ["Zeta"]), row(ids[3]!, "a3", []), row(ids[4]!, "a4", null)]),
    );
    return LocalSource.open(store);
  }

  it("lists every tag in the workspace like the server: most used first, then alphabetically, in the first spelling", async () => {
    expect(await (await tagged()).workspaceTags()).toEqual(["UI", "alpha", "Back end", "Zeta"]);
  });

  it("is empty for a workspace without tags", async () => {
    const source = await LocalSource.open(new MemoryStore());
    expect(await source.workspaceTags()).toEqual([]);
    await source.createProject({ name: "Launch" });
    expect(await source.workspaceTags()).toEqual([]);
  });

  it("tagging uses the spelling already in the workspace, from any project", async () => {
    const source = await tagged();
    const link = source.openBoard(OTHER).openLink();
    const received = inbox(link);
    await settle();
    link.send(JSON.stringify({ type: "join", projectId: OTHER, version: 1, protocol: PROTOCOL_VERSION }));
    link.send(JSON.stringify({ type: "command", commandId: BUILD, command: { type: "setTags", id: ids[5], tags: ["back END", "zeta", "New one", "alpha"] } }));
    await settle();
    expect(received.filter((message) => message.type === "reject")).toEqual([]);
    expect((await source.openBoard(OTHER).load()).rows[0]).toMatchObject({ tags: ["Back end", "Zeta", "New one", "alpha"] });
    expect(await source.workspaceTags()).toEqual(["Back end", "UI", "Zeta", "alpha", "New one"]);
  });
});
