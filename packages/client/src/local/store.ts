import type { ProjectRecord, WorkspaceRecord } from "./records";

export interface StoredWorkspace {
  /** null until the first change is saved */
  workspace: WorkspaceRecord | null;
  projects: ProjectRecord[];
}

/** Where a local workspace is kept (IndexedDB in the browser; memory in tests). */
export interface LocalStore {
  load(): Promise<StoredWorkspace>;
  saveWorkspace(workspace: WorkspaceRecord): Promise<void>;
  saveProject(project: ProjectRecord): Promise<void>;
  deleteProject(id: string): Promise<void>;
  /** Replaces everything at once (an import, or clearing the workspace). */
  replaceAll(workspace: WorkspaceRecord, projects: ProjectRecord[]): Promise<void>;
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A store in memory (tests, and a fallback when the browser can't store anything). */
export class MemoryStore implements LocalStore {
  private workspace: WorkspaceRecord | null = null;
  private readonly projects = new Map<string, ProjectRecord>();

  async load(): Promise<StoredWorkspace> {
    return { workspace: this.workspace && copy(this.workspace), projects: [...this.projects.values()].map(copy) };
  }
  async saveWorkspace(workspace: WorkspaceRecord): Promise<void> {
    this.workspace = copy(workspace);
  }
  async saveProject(project: ProjectRecord): Promise<void> {
    this.projects.set(project.id, copy(project));
  }
  async deleteProject(id: string): Promise<void> {
    this.projects.delete(id);
  }
  async replaceAll(workspace: WorkspaceRecord, projects: ProjectRecord[]): Promise<void> {
    this.workspace = copy(workspace);
    this.projects.clear();
    for (const project of projects) this.projects.set(project.id, copy(project));
  }
}
