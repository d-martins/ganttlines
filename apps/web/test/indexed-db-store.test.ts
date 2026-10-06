import { LocalSource } from "@ganttlines/client";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { IndexedDbStore } from "../src/workspace/indexed-db-store";

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
});
