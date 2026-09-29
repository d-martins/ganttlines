import type { Db } from "@ganttlines/db";
import { conflict } from "../errors";

/** Archived projects are read-only: comments, highlights and baselines cannot be added or changed. */
export async function assertNotArchived(db: Db, projectId: string): Promise<void> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { archivedAt: true } });
  if (project?.archivedAt) throw conflict("This project is archived");
}
