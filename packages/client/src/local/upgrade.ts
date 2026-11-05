import type { Link, Row } from "@ganttlines/engine";
import { WORKSPACE_VERSION, type ProjectRecord, type WorkspaceRecord } from "./records";

/** A version 1 task row: its single predecessor and that link's delay were kept on the row. */
type RowV1 = Row & { predecessorId?: string | null; offset?: number };

/**
 * A project record from any older version at the current one. Pure: a current record is returned
 * as it is, and so is one that isn't a project record at all (it is never thrown on, so one damaged
 * record can't stop the rest of the workspace from opening).
 */
export function upgradeProjectRecord(record: unknown): ProjectRecord {
  if (!isRecordShaped(record)) return record as ProjectRecord;
  return withInterruptions(withTargets(withTagsAndDescriptions(withLinks(record as Omit<ProjectRecord, "rows" | "links"> & { rows: RowV1[]; links?: Link[] }))));
}

/**
 * Version 1 → 2: each task's predecessor becomes a finish-to-start link with the offset as its
 * delay, and the rows lose those fields. A predecessor that isn't in the project, or a task naming
 * itself, is dropped.
 */
function withLinks(project: Omit<ProjectRecord, "rows" | "links"> & { rows: RowV1[]; links?: Link[] }): ProjectRecord {
  if (Array.isArray(project.links)) return project as ProjectRecord;
  const ids = new Set(project.rows.map((row) => row.id));
  const links: Link[] = [];
  const rows = project.rows.map((row): Row => {
    const { predecessorId, offset, ...rest } = row;
    if (row.kind === "task" && predecessorId && predecessorId !== row.id && ids.has(predecessorId)) {
      links.push({ predecessorId, followerId: row.id, kind: "FS", lag: offset ?? 0 });
    }
    return rest as Row;
  });
  return { ...project, rows, links };
}

/** Version 2 → 3: tasks get an empty tag list and sections an empty description. */
function withTagsAndDescriptions(project: ProjectRecord): ProjectRecord {
  const outdated = (row: Row) => (row.kind === "task" ? !Array.isArray(row.tags) : typeof row.description !== "string");
  if (!project.rows.some(outdated)) return project;
  const rows = project.rows.map((row): Row => {
    if (!outdated(row)) return row;
    return row.kind === "task" ? { ...row, tags: [] } : { ...row, description: "" };
  });
  return { ...project, rows };
}

/** Version 3 → 4: tasks aim for nothing yet. */
function withTargets(project: ProjectRecord): ProjectRecord {
  const outdated = (row: Row) => row.kind === "task" && row.targetId === undefined;
  if (!project.rows.some(outdated)) return project;
  return { ...project, rows: project.rows.map((row): Row => (row.kind === "task" && outdated(row) ? { ...row, targetId: null } : row)) };
}

/** Version 4 → 5: tasks have no interruptions yet. */
function withInterruptions(project: ProjectRecord): ProjectRecord {
  const outdated = (row: Row) => row.kind === "task" && (row.breaks === undefined || row.interruptedBy === undefined);
  if (!project.rows.some(outdated)) return project;
  return { ...project, rows: project.rows.map((row): Row => (row.kind === "task" && outdated(row) ? { ...row, breaks: row.breaks ?? [], interruptedBy: row.interruptedBy ?? [] } : row)) };
}

function isRecordShaped(record: unknown): boolean {
  if (typeof record !== "object" || record === null) return false;
  const { rows } = record as { rows?: unknown };
  return Array.isArray(rows) && rows.every((row) => typeof row === "object" && row !== null);
}

/** A workspace record at the current version (its own fields didn't change; its projects' did). */
export function upgradeWorkspaceRecord(record: WorkspaceRecord): WorkspaceRecord {
  return record.version === WORKSPACE_VERSION ? record : { ...record, version: WORKSPACE_VERSION };
}
