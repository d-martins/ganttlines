import type { LocalStore, ProjectRecord, StoredWorkspace, WorkspaceRecord } from "@ganttlines/client";

const WORKSPACE = "workspace";
const PROJECTS = "projects";

/** This browser's workspace in IndexedDB: one workspace record, one record per project. */
export class IndexedDbStore implements LocalStore {
  private db: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly name = "ganttlines",
    private readonly factory: IDBFactory | undefined = globalThis.indexedDB,
  ) {}

  async load(): Promise<StoredWorkspace> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([WORKSPACE, PROJECTS], "readonly");
      const workspace = tx.objectStore(WORKSPACE).get(WORKSPACE);
      const projects = tx.objectStore(PROJECTS).getAll();
      tx.oncomplete = () => resolve({ workspace: (workspace.result as WorkspaceRecord | undefined) ?? null, projects: projects.result as ProjectRecord[] });
      tx.onerror = () => reject(tx.error);
    });
  }

  saveWorkspace(workspace: WorkspaceRecord): Promise<void> {
    return this.write([WORKSPACE], (tx) => tx.objectStore(WORKSPACE).put(workspace, WORKSPACE));
  }

  saveProject(project: ProjectRecord): Promise<void> {
    return this.write([PROJECTS], (tx) => tx.objectStore(PROJECTS).put(project));
  }

  deleteProject(id: string): Promise<void> {
    return this.write([PROJECTS], (tx) => tx.objectStore(PROJECTS).delete(id));
  }

  replaceAll(workspace: WorkspaceRecord, projects: ProjectRecord[]): Promise<void> {
    return this.write([WORKSPACE, PROJECTS], (tx) => {
      const store = tx.objectStore(PROJECTS);
      store.clear();
      for (const project of projects) store.put(project);
      tx.objectStore(WORKSPACE).put(workspace, WORKSPACE);
    });
  }

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      const opening = new Promise<IDBDatabase>((resolve, reject) => {
        if (!this.factory) throw new Error("This browser can't store data");
        const request = this.factory.open(this.name, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore(WORKSPACE);
          request.result.createObjectStore(PROJECTS, { keyPath: "id" });
        };
        request.onsuccess = () => {
          const db = request.result;
          // Another tab upgrading, or the browser closing the database: open it again next time.
          db.onversionchange = () => {
            db.close();
            this.db = null;
          };
          db.onclose = () => {
            this.db = null;
          };
          resolve(db);
        };
        request.onerror = () => reject(request.error);
      });
      // A failed open is tried again next time (e.g. storage was blocked for a moment).
      opening.catch(() => {
        if (this.db === opening) this.db = null;
      });
      this.db = opening;
    }
    return this.db;
  }

  /** One transaction; resolves once it's committed (so a reload never misses it), and is all-or-nothing. */
  private async write(stores: string[], work: (tx: IDBTransaction) => unknown): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("Couldn't save the workspace"));
      try {
        work(tx);
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  }
}
