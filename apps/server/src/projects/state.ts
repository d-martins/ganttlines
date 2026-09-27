import { toEngineRow, type Db } from "@ganttlines/db";
import type { Row } from "@ganttlines/engine";
import type { ProjectStateDto } from "@ganttlines/protocol";
import { toProjectDto } from "../dto";
import { HttpError, notFound } from "../errors";

export class CorruptProjectError extends HttpError {
  constructor(projectId: string, detail: string) {
    super(500, "project_corrupt", `Project ${projectId} has inconsistent data: ${detail}`);
  }
}

export async function loadProjectState(db: Db, projectId: string): Promise<ProjectStateDto> {
  const project = await db.project.findUnique({ where: { id: projectId }, include: { rows: true } });
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
  return { project: toProjectDto(meta), rows };
}

/** Parent links must point to rows of the same project and never loop; sections never sit inside tasks. */
export function findTreeProblem(rows: readonly Row[]): string | null {
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
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
