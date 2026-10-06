import type { LocalStore, ProjectRecord, StoredWorkspace, WorkspaceRecord } from "@ganttlines/client";

/**
 * Asks the browser to keep this site's storage (not clear it when space runs low), once, at the first
 * saved change. Once stopped (another tab took the workspace over), it writes nothing more: that
 * tab's copy is the one kept.
 */
export class PersistingStore implements LocalStore {
  private asked = false;
  private stopped = false;

  constructor(
    private readonly inner: LocalStore,
    private readonly persist: () => Promise<unknown> | undefined = () => navigator.storage?.persist?.(),
  ) {}

  load(): Promise<StoredWorkspace> {
    return this.inner.load();
  }
  async saveWorkspace(workspace: WorkspaceRecord): Promise<void> {
    if (this.stopped) return;
    await this.inner.saveWorkspace(workspace);
    this.ask();
  }
  async saveProject(project: ProjectRecord): Promise<void> {
    if (this.stopped) return;
    await this.inner.saveProject(project);
    this.ask();
  }
  async deleteProject(id: string): Promise<void> {
    if (this.stopped) return;
    await this.inner.deleteProject(id);
    this.ask();
  }
  async replaceAll(workspace: WorkspaceRecord, projects: ProjectRecord[]): Promise<void> {
    if (this.stopped) return;
    await this.inner.replaceAll(workspace, projects);
    this.ask();
  }

  stop(): void {
    this.stopped = true;
  }

  private ask(): void {
    if (this.asked) return;
    this.asked = true;
    void Promise.resolve()
      .then(this.persist)
      .catch(() => undefined);
  }
}
