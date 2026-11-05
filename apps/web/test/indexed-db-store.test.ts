import * as client from "@ganttlines/client";
import { emptyWorkspace, LocalSource, WORKSPACE_VERSION } from "@ganttlines/client";
import { TASK_DEFAULTS } from "@ganttlines/engine";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { IndexedDbStore } from "../src/workspace/indexed-db-store";
import { fillWorkspace } from "@ganttlines/client/testing";

vi.mock("@ganttlines/client", async (original) => {
  const actual = await original<typeof import("@ganttlines/client")>();
  return { ...actual, upgradeProjectRecord: vi.fn(actual.upgradeProjectRecord) };
});

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const v1Task = (id: string, predecessorId: string | null, offset: number) => ({ ...TASK_DEFAULTS, id, kind: "task", title: id, parentId: null, position: "a0", predecessorId, offset });
const v1Project = (id: string) => ({ id, name: "Launch", archived: false, createdAt: "2026-10-01T00:00:00.000Z", version: 3, rows: [v1Task(A, null, 0), v1Task(B, A, -1)], highlights: [], baselines: [] });

/** A database as this app left it before links: version 1, with records in the version 1 shape. */
function openRaw(factory: IDBFactory, name: string, version: number, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    request.onupgradeneeded = () => upgrade?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function versionOneDatabase(factory: IDBFactory, name: string, projectIds: string[]): Promise<IDBDatabase> {
  const db = await openRaw(factory, name, 1, (created) => {
    created.createObjectStore("workspace");
    created.createObjectStore("projects", { keyPath: "id" });
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["workspace", "projects"], "readwrite");
    tx.objectStore("workspace").put({ ...emptyWorkspace(), version: 1 }, "workspace");
    for (const id of projectIds) tx.objectStore("projects").put(v1Project(id));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return db;
}

const { tags: _tags, ...v2TaskFields } = TASK_DEFAULTS;
const v2Project = (id: string) => ({
  id,
  name: "Launch",
  archived: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  version: 3,
  rows: [{ ...v2TaskFields, id: A, kind: "task", title: "A", parentId: null, position: "a0" }, { id: B, kind: "section", title: "S", parentId: null, position: "a1" }],
  links: [],
  highlights: [],
  baselines: [],
});

/** A database as this app left it before tags: version 2, tasks without tags and sections without descriptions. */
async function versionTwoDatabase(factory: IDBFactory, name: string, projectIds: string[]): Promise<IDBDatabase> {
  const db = await openRaw(factory, name, 2, (created) => {
    created.createObjectStore("workspace");
    created.createObjectStore("projects", { keyPath: "id" });
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["workspace", "projects"], "readwrite");
    tx.objectStore("workspace").put({ ...emptyWorkspace(), version: 2 }, "workspace");
    for (const id of projectIds) tx.objectStore("projects").put(v2Project(id));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return db;
}

function readAll(db: IDBDatabase): Promise<{ workspace: unknown; projects: unknown[] }> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["workspace", "projects"], "readonly");
    const workspace = tx.objectStore("workspace").get("workspace");
    const projects = tx.objectStore("projects").getAll();
    tx.oncomplete = () => resolve({ workspace: workspace.result, projects: projects.result });
    tx.onerror = () => reject(tx.error);
  });
}

describe("the workspace in IndexedDB", () => {
  it("is there again on the next visit (a new store on the same database)", async () => {
    const factory = new IDBFactory();
    const first = await LocalSource.open(new IndexedDbStore("test", factory));
    const project = await first.createProject({ name: "Launch" });
    await first.createResource({ name: "Ana" });
    await first.saveHighlight(project.id, { date: "2026-10-09", label: "Demo", color: "#e5892f" });
    const again = await LocalSource.open(new IndexedDbStore("test", factory));
    expect(await again.listProjects()).toEqual(await first.listProjects());
    expect(await again.resources()).toEqual(await first.resources());
    expect(await again.highlights(project.id)).toEqual(await first.highlights(project.id));
  });

  it("gives back everything — rows, baselines, calendar — when reopened", async () => {
    const factory = new IDBFactory();
    const first = await LocalSource.open(new IndexedDbStore("full", factory));
    await fillWorkspace(first);
    const contents = (source: LocalSource) => ({ ...source.exportFile(), exportedAt: "" });
    expect(contents(first).projects[0]?.baselines).toHaveLength(1);
    expect(contents(await LocalSource.open(new IndexedDbStore("full", factory)))).toEqual(contents(first));
  });

  it("deletes projects and replaces everything at once", async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbStore("test", factory);
    const source = await LocalSource.open(store);
    const keep = await source.createProject({ name: "Keep" });
    const drop = await source.createProject({ name: "Drop" });
    await source.updateProject(drop.id, { archived: true });
    await source.deleteProject(drop.id);
    expect((await new IndexedDbStore("test", factory).load()).projects.map((project) => project.id)).toEqual([keep.id]);
    await source.clear();
    expect(await new IndexedDbStore("test", factory).load()).toMatchObject({ projects: [], workspace: { team: [] } });
  });

  it("opening a version-1 database upgrades its projects to links", async () => {
    const factory = new IDBFactory();
    (await versionOneDatabase(factory, "old", ["p1", "p2"])).close();
    await new IndexedDbStore("old", factory).load();
    // Written back in the upgrade itself, not on the next save: the stored records are the current version.
    const db = await openRaw(factory, "old", 5);
    const { workspace, projects } = await readAll(db);
    db.close();
    expect(workspace).toMatchObject({ version: WORKSPACE_VERSION });
    expect(projects).toHaveLength(2);
    for (const project of projects as client.ProjectRecord[]) {
      expect(project.links).toEqual([{ predecessorId: A, followerId: B, kind: "FS", lag: -1 }]);
      for (const row of project.rows) expect(row).not.toHaveProperty("predecessorId");
      for (const row of project.rows) expect(row).toMatchObject({ tags: [] });
    }
  });

  it("opening a version-2 database gives every task tags and every section a description", async () => {
    const factory = new IDBFactory();
    (await versionTwoDatabase(factory, "v2", ["p1", "p2", "p3"])).close();
    await new IndexedDbStore("v2", factory).load();
    // Written back in the upgrade itself, not on the next save: the stored records are current.
    const db = await openRaw(factory, "v2", 5);
    const { workspace, projects } = await readAll(db);
    db.close();
    expect(workspace).toMatchObject({ version: 4 });
    expect(projects).toHaveLength(3);
    for (const project of projects as client.ProjectRecord[]) {
      expect(project.rows).toEqual([expect.objectContaining({ id: A, kind: "task", tags: [], targetId: null }), { id: B, kind: "section", title: "S", parentId: null, position: "a1", description: "" }]);
    }
  });

  it("opening a version-3 database gives every task no target, written back in the upgrade", async () => {
    const factory = new IDBFactory();
    const old = await openRaw(factory, "v3", 3, (created) => {
      created.createObjectStore("workspace");
      created.createObjectStore("projects", { keyPath: "id" });
    });
    await new Promise<void>((resolve, reject) => {
      const tx = old.transaction(["workspace", "projects"], "readwrite");
      tx.objectStore("workspace").put({ ...emptyWorkspace(), version: 3 }, "workspace");
      tx.objectStore("projects").put({ ...v1Project("p1"), links: [], rows: [{ id: A, kind: "task", title: "A", parentId: null, position: "a0", userStart: null, startsAfternoon: false, duration: 1, actualDuration: null, resourceId: null, color: "blue", locked: false, description: "", tags: ["UI"] }] });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    old.close();
    await new IndexedDbStore("v3", factory).load();
    const db = await openRaw(factory, "v3", 5);
    const { workspace, projects } = await readAll(db);
    db.close();
    expect(workspace).toMatchObject({ version: 5 });
    expect((projects as client.ProjectRecord[])[0]!.rows).toEqual([expect.objectContaining({ id: A, tags: ["UI"], targetId: null, breaks: [], interruptedBy: [] })]);
  });

  it("a failed version-2 upgrade leaves the version-2 data", async () => {
    const factory = new IDBFactory();
    (await versionTwoDatabase(factory, "failing-v2", ["p1", "p2"])).close();
    const { upgradeProjectRecord } = await vi.importActual<typeof client>("@ganttlines/client");
    vi.mocked(client.upgradeProjectRecord)
      .mockImplementationOnce(upgradeProjectRecord)
      .mockImplementationOnce(() => {
        throw new Error("unreadable project");
      });
    await expect(new IndexedDbStore("failing-v2", factory).load()).rejects.toThrow();
    const db = await openRaw(factory, "failing-v2", 2);
    const { workspace, projects } = await readAll(db);
    db.close();
    expect(workspace).toMatchObject({ version: 2 });
    expect(projects).toEqual([v2Project("p1"), v2Project("p2")]);
  });

  it("an open older connection is closed when the upgrade starts", async () => {
    const factory = new IDBFactory();
    const older = await versionOneDatabase(factory, "tabs", ["p1"]);
    const versionChange = vi.fn(() => older.close());
    older.onversionchange = versionChange;
    expect((await new IndexedDbStore("tabs", factory).load()).projects).toHaveLength(1);
    expect(versionChange).toHaveBeenCalledTimes(1);
  });

  it("a failed upgrade leaves the version-1 data", async () => {
    const factory = new IDBFactory();
    (await versionOneDatabase(factory, "failing", ["p1", "p2"])).close();
    const { upgradeProjectRecord } = await vi.importActual<typeof client>("@ganttlines/client");
    // The first project upgrades, the second throws: neither is left changed.
    vi.mocked(client.upgradeProjectRecord)
      .mockImplementationOnce(upgradeProjectRecord)
      .mockImplementationOnce(() => {
        throw new Error("unreadable project");
      });
    await expect(new IndexedDbStore("failing", factory).load()).rejects.toThrow();
    const db = await openRaw(factory, "failing", 1);
    const { workspace, projects } = await readAll(db);
    db.close();
    expect(workspace).toMatchObject({ version: 1 });
    expect(projects).toEqual([v1Project("p1"), v1Project("p2")]);
  });
});
