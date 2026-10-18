import { toEngineLink, toEngineRow, type Db, type Project } from "@ganttlines/db";
import { findLinkProblem, findTreeProblem, linkKey, type Link, type ProjectState, type Row } from "@ganttlines/engine";
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

/** Reads a project, its rows and its links in one consistent snapshot, refusing corrupted data. */
export async function readProject(db: Db, projectId: string): Promise<StoredProject> {
  const project = await db.$transaction(
    (tx) => tx.project.findUnique({ where: { id: projectId }, include: { rows: true, links: true } }),
    { isolationLevel: "RepeatableRead" },
  );
  if (!project) throw notFound("Project");
  let rows: Row[];
  let links: Link[];
  try {
    rows = project.rows.map(toEngineRow);
    links = project.links.map(toEngineLink);
  } catch (error) {
    throw new CorruptProjectError(projectId, (error as Error).message);
  }
  const problem = findTreeProblem(rows) ?? findLinkProblem(rows, links);
  if (problem) throw new CorruptProjectError(projectId, problem);
  const { rows: _rows, links: _links, ...meta } = project;
  return {
    meta,
    state: { rows: Object.fromEntries(rows.map((row) => [row.id, row])), links: Object.fromEntries(links.map((link) => [linkKey(link), link])) },
  };
}
