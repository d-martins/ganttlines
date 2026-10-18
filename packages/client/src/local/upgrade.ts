import type { Link, Row } from "@ganttlines/engine";
import { WORKSPACE_VERSION, type ProjectRecord, type WorkspaceRecord } from "./records";

/** A version 1 task row: its single predecessor and that link's delay were kept on the row. */
type RowV1 = Row & { predecessorId?: string | null; offset?: number };

/**
 * A version 1 project record (task rows with `predecessorId`/`offset`) as version 2: each
 * predecessor becomes a finish-to-start link with the offset as its delay, and the rows lose those
 * fields. A predecessor that isn't in the project, or a task naming itself, is dropped. Pure; a
 * version 2 record is returned unchanged.
 */
export function upgradeProjectRecord(record: unknown): ProjectRecord {
  const project = record as Omit<ProjectRecord, "rows" | "links"> & { rows: RowV1[]; links?: Link[] };
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

/** A workspace record at the current version (its own fields didn't change; its projects' did). */
export function upgradeWorkspaceRecord(record: WorkspaceRecord): WorkspaceRecord {
  return record.version === WORKSPACE_VERSION ? record : { ...record, version: WORKSPACE_VERSION };
}
