import type { LocalStore, ProjectRecord, StoredWorkspace, WorkspaceRecord } from "@ganttlines/client";

/** Asks the browser to keep this site's storage (not clear it when space runs low), once, at the first saved change. */
export class PersistingStore implements LocalStore {
  private asked = false;

  constructor(
    private readonly inner: LocalStore,
    private readonly persist: () => Promise<unknown> | undefined = () => navigator.storage?.persist?.(),
  ) {}

  load(): Promise<StoredWorkspace> {
    return this.inner.load();
  }
  async saveWorkspace(workspace: WorkspaceRecord): Promise<void> {
    await this.inner.saveWorkspace(workspace);
    this.ask();
  }
  async saveProject(project: ProjectRecord): Promise<void> {
    await this.inner.saveProject(project);
    this.ask();
  }
  async deleteProject(id: string): Promise<void> {
    await this.inner.deleteProject(id);
    this.ask();
  }
  async replaceAll(workspace: WorkspaceRecord, projects: ProjectRecord[]): Promise<void> {
    await this.inner.replaceAll(workspace, projects);
    this.ask();
  }

  private ask(): void {
    if (this.asked) return;
    this.asked = true;
    void Promise.resolve()
      .then(this.persist)
      .catch(() => undefined);
  }
}
