import { TASK_COLORS, type Break, type Row, type TaskColor } from "@ganttlines/engine";
import type { Prisma, Row as DbRow } from "../generated/prisma/client";

/** Stored row → engine row. Sections drop the task-only columns (they keep a description). */
export function toEngineRow(row: Omit<DbRow, "breaks"> & { breaks: unknown }): Row {
  const base = {
    id: row.id,
    title: row.title,
    parentId: row.parentId,
    position: row.position,
  };
  if (row.kind === "section") return { ...base, kind: "section", description: row.description };
  if (row.kind !== "task") throw new Error(`Row ${row.id} has unknown kind ${row.kind}`);
  if (!(TASK_COLORS as readonly string[]).includes(row.color)) throw new Error(`Row ${row.id} has unknown color ${row.color}`);
  return {
    ...base,
    kind: "task",
    userStart: row.userStart,
    startsAfternoon: row.startsAfternoon,
    duration: row.duration,
    resourceId: row.resourceId,
    color: row.color as TaskColor,
    locked: row.locked,
    description: row.description,
    actualDuration: row.actualDuration,
    tags: [...row.tags],
    targetId: row.targetId,
    breaks: row.breaks as unknown as Break[],
    interruptedBy: [...row.interruptedBy],
  };
}

/** Engine row → columns to store (without projectId). Sections store task-column defaults. */
export function toDbColumns(row: Row): Omit<DbRow, "projectId" | "breaks"> & { breaks: Prisma.InputJsonValue } {
  const base = {
    id: row.id,
    kind: row.kind,
    title: row.title,
    parentId: row.parentId,
    position: row.position,
  };
  if (row.kind === "section") {
    return {
      ...base,
      userStart: null,
      startsAfternoon: false,
      duration: 1,
      resourceId: null,
      color: "blue",
      locked: false,
      description: row.description,
      actualDuration: null,
      tags: [],
      targetId: null,
      breaks: [],
      interruptedBy: [],
    };
  }
  return {
    ...base,
    userStart: row.userStart,
    startsAfternoon: row.startsAfternoon,
    duration: row.duration,
    resourceId: row.resourceId,
    color: row.color,
    locked: row.locked,
    description: row.description,
    actualDuration: row.actualDuration,
    tags: [...row.tags],
    targetId: row.targetId,
    breaks: row.breaks.map((pause) => ({ ...pause })),
    interruptedBy: [...row.interruptedBy],
  };
}
