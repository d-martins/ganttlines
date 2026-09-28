import { MAX_DATE, MAX_DURATION, MAX_OFFSET, MIN_DATE, TASK_COLORS, type Command } from "@ganttlines/engine";
import { z } from "zod";

export const COMMAND_LIMITS = {
  titleMax: 500,
  descriptionMax: 20_000,
  deleteRowsMax: 5_000,
} as const;

const id = z.uuid();
const date = z.iso.date().refine((value) => value >= MIN_DATE && value <= MAX_DATE, `Dates must be between ${MIN_DATE} and ${MAX_DATE}`);
const title = z.string().max(COMMAND_LIMITS.titleMax);
const cmd = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) => z.strictObject({ type: z.literal(type), ...shape });

/** Wire schema for every engine row command (spec §5.7), bounding what the engine does not. */
export const CommandSchema = z.discriminatedUnion("type", [
  cmd("createRow", {
    id,
    kind: z.enum(["task", "section"]),
    parentId: id.nullable(),
    afterId: id.nullable(),
    title,
    start: date.optional(),
  }),
  cmd("updateTitle", { id, title }),
  cmd("setDescription", { id, description: z.string().max(COMMAND_LIMITS.descriptionMax) }),
  cmd("setColor", { id, color: z.enum(TASK_COLORS) }),
  cmd("toggleCollapsed", { id, collapsed: z.boolean() }),
  cmd("setAssignee", { id, resourceId: id.nullable() }),
  cmd("moveTask", { id, start: date }),
  cmd("resizeTask", { id, edge: z.enum(["start", "end"]), date }),
  cmd("setDuration", { id, duration: z.int().min(1).max(MAX_DURATION) }),
  cmd("convertMilestone", { id, milestone: z.boolean() }),
  cmd("setLocked", { id, locked: z.boolean() }),
  cmd("linkTasks", { fromId: id, toId: id }),
  cmd("removePredecessor", { id }),
  cmd("setOffset", { id, offset: z.int().min(-MAX_OFFSET).max(MAX_OFFSET) }),
  cmd("indent", { id }),
  cmd("outdent", { id }),
  cmd("moveRow", { id, parentId: id.nullable(), afterId: id.nullable() }),
  cmd("deleteRows", { ids: z.array(id).min(1).max(COMMAND_LIMITS.deleteRowsMax) }),
  cmd("duplicateTask", { id, newId: id }),
]);

/** Body of POST /api/projects/:id/commands. `commandId` makes retries idempotent. */
export const ProjectCommandBody = z.strictObject({ commandId: id, command: CommandSchema });

/** Body of POST /api/projects/:id/undo and /redo; `commandId` identifies the undo/redo itself. */
export const UndoBody = z.strictObject({ commandId: id });

/** Parsed wire command → engine command (drops keys zod reports as explicitly undefined). */
export function toEngineCommand(parsed: z.output<typeof CommandSchema>): Command {
  return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined)) as Command;
}
