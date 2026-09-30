import { TASK_COLORS, type Row, type TaskColor } from "@ganttlines/engine";
import type { Row as DbRow } from "../generated/prisma/client";

/** Stored row → engine row. Sections drop the task-only columns. */
export function toEngineRow(row: DbRow): Row {
  const base = {
    id: row.id,
    title: row.title,
    parentId: row.parentId,
    position: row.position,
    collapsed: row.collapsed,
  };
  if (row.kind === "section") return { ...base, kind: "section" };
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
    predecessorId: row.predecessorId,
    offset: row.offset,
    description: row.description,
    actualDuration: row.actualDuration,
  };
}

/** Engine row → columns to store (without projectId). Sections store task-column defaults. */
export function toDbColumns(row: Row): Omit<DbRow, "projectId"> {
  const base = {
    id: row.id,
    kind: row.kind,
    title: row.title,
    parentId: row.parentId,
    position: row.position,
    collapsed: row.collapsed,
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
      predecessorId: null,
      offset: 0,
      description: "",
      actualDuration: null,
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
    predecessorId: row.predecessorId,
    offset: row.offset,
    description: row.description,
    actualDuration: row.actualDuration,
  };
}
