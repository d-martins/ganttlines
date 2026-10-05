import { toEngineRow, type Db, type Project } from "@ganttlines/db";
import { findTreeProblem, type ProjectState, type Row } from "@ganttlines/engine";
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
