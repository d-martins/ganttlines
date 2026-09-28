import { toEngineRow, type Db, type Project } from "@ganttlines/db";
import type { ProjectState, Row } from "@ganttlines/engine";
import { HttpError, notFound } from "../errors";

export class CorruptProjectError extends HttpError {
  constructor(projectId: string, detail: string) {
    super(500, "project_corrupt", `Project ${projectId} has inconsistent data: ${detail}`);
  }
}

export interface StoredProject {
  meta: Project;
  state: ProjectState;
}

/** Reads a project and its rows in one consistent snapshot, refusing corrupted data. */
export async function readProject(db: Db, projectId: string): Promise<StoredProject> {
  const project = await db.$transaction(
    (tx) => tx.project.findUnique({ where: { id: projectId }, include: { rows: true } }),
    { isolationLevel: "RepeatableRead" },
  );
  if (!project) throw notFound("Project");
  let rows: Row[];
  try {
    rows = project.rows.map(toEngineRow);
  } catch (error) {
    throw new CorruptProjectError(projectId, (error as Error).message);
  }
  const problem = findTreeProblem(rows);
  if (problem) throw new CorruptProjectError(projectId, problem);
  const { rows: _rows, ...meta } = project;
  return { meta, state: { rows: Object.fromEntries(rows.map((row) => [row.id, row])) } };
}

/**
 * Parent links must point to rows of the same project and never loop; sections never sit inside
 * tasks; predecessors must be tasks of the same project.
 */
export function findTreeProblem(rows: readonly Row[]): string | null {
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    if (row.kind === "task" && row.predecessorId !== null && byId.get(row.predecessorId)?.kind !== "task") {
      return `task ${row.id} has a missing predecessor ${row.predecessorId}`;
    }
    if (row.parentId === null) continue;
    const parent = byId.get(row.parentId);
    if (!parent) return `row ${row.id} has a missing parent ${row.parentId}`;
    if (row.kind === "section" && parent.kind === "task") return `section ${row.id} is inside task ${parent.id}`;
    const seen = new Set([row.id]);
    for (let current: Row | undefined = parent; current; current = current.parentId ? byId.get(current.parentId) : undefined) {
      if (seen.has(current.id)) return `row ${row.id} is part of a parent loop`;
      seen.add(current.id);
    }
  }
  return null;
}
