import { emptyWorkspace, LocalSource, MemoryStore, type ProjectRecord } from "@ganttlines/client";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetLocalWorkspace, openLocalWorkspace, useStorageStatus } from "../src/workspace/local";
import { IndexedDbStore } from "../src/workspace/indexed-db-store";
import { PersistingStore } from "../src/workspace/persisting-store";

beforeEach(() => {
  forgetLocalWorkspace();
  useStorageStatus.setState({ failed: false });
});

describe("storing the workspace in the browser", () => {
  it("asks the browser to keep it, once, when the first change is saved", async () => {
    const persist = vi.fn(async () => true);
    const source = await LocalSource.open(new PersistingStore(new MemoryStore(), persist));
    expect(persist).not.toHaveBeenCalled();
    await source.createProject({ name: "A" });
    await source.createProject({ name: "B" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("says when the browser can't store anything, and tries again next time", async () => {
    await expect(new IndexedDbStore("x", undefined).load()).rejects.toThrow(/can't store/);
    const real = new IDBFactory();
    let first = true;
    const flaky = {
      open: (name: string, version?: number) => {
        if (first) {
          first = false;
          throw new Error("blocked");
        }
        return real.open(name, version);
      },
    } as unknown as IDBFactory;
    const store = new IndexedDbStore("flaky", flaky);
    await expect(store.load()).rejects.toThrow(/blocked/);
    await expect(store.load()).resolves.toEqual({ workspace: null, projects: [] });
  });

  it("never half-writes: a write that fails changes nothing", async () => {
    const store = new IndexedDbStore("whole", new IDBFactory());
    const source = await LocalSource.open(store);
    const keep = await source.createProject({ name: "Keep" });
    const broken = { id: "x", name: "Broken", rows: [() => undefined] } as unknown as ProjectRecord;
    await expect(store.replaceAll((await store.load()).workspace ?? emptyWorkspace(), [broken])).rejects.toThrow();
    expect((await store.load()).projects.map((project) => project.id)).toEqual([keep.id]);
  });

  it("works in memory, and says so, where nothing can be stored", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const source = await openLocalWorkspace();
    await source.createProject({ name: "Still works" });
    expect(await source.listProjects()).toEqual([expect.objectContaining({ name: "Still works" })]);
    expect(useStorageStatus.getState().failed).toBe(true);
    vi.unstubAllGlobals();
  });
});
