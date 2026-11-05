import { MAX_DATE, MAX_DURATION, MAX_LAG, MAX_TAG_LENGTH, MAX_TAGS_PER_TASK, MIN_DATE, TASK_COLORS, type Command } from "@ganttlines/engine";
import { z } from "zod";
import { COMMAND_LIMITS } from "./constants";

export { COMMAND_LIMITS };


const id = z.uuid();
const date = z.iso.date().refine((value) => value >= MIN_DATE && value <= MAX_DATE, `Dates must be between ${MIN_DATE} and ${MAX_DATE}`);
const title = z.string().max(COMMAND_LIMITS.titleMax);
/** Working days in whole or half steps (0.5, 1, 2.5 …). */
const halfDays = z
  .number()
  .min(0.5)
  .max(MAX_DURATION)
  .refine((days) => Number.isInteger(days * 2), "Use whole or half days");
const linkKind = z.enum(["FS", "SS", "FF", "SF"]);
/** Working days in half steps; the engine checks which kinds may be negative. */
const lag = z
  .number()
  .min(-MAX_LAG)
  .max(MAX_LAG)
  .refine((days) => Number.isInteger(days * 2), "Use whole or half days");
/** Which half of a day: moves and resizes snap to half days at day zoom. */
const half = z.enum(["morning", "afternoon"]).optional();
const cmd = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) => z.strictObject({ type: z.literal(type), ...shape });

const setTarget = cmd("setTarget", { id, targetId: id.nullable() });
const addLink = cmd("addLink", { predecessorId: id, followerId: id, kind: linkKind, lag: lag.optional() });
const removeLink = cmd("removeLink", { predecessorId: id, followerId: id, kind: linkKind, keepPlace: z.boolean().optional() });

/** Wire schema for every engine row command, bounding what the engine does not. */
export const CommandSchema = z.discriminatedUnion("type", [
  cmd("createRow", {
    id,
    kind: z.enum(["task", "section"]),
    parentId: id.nullable(),
    afterId: id.nullable(),
    title,
    start: date.optional(),
    milestone: z.boolean().optional(),
  }),
  cmd("updateTitle", { id, title }),
  cmd("setDescription", { id, description: z.string().max(COMMAND_LIMITS.descriptionMax) }),
  cmd("setColor", { id, color: z.enum(TASK_COLORS) }),
  /** The task's whole tag list, in order; the engine drops empty and repeated tags. */
  cmd("setTags", { id, tags: z.array(z.string().trim().max(MAX_TAG_LENGTH)).max(MAX_TAGS_PER_TASK) }),
  setTarget,
  cmd("createTargetMilestone", { id, newId: id, title, parentId: id.nullable(), afterId: id.nullable(), start: date }),
  cmd("setAssignee", { id, resourceId: id.nullable() }),
  cmd("moveTask", { id, start: date, half }),
  cmd("resizeTask", { id, edge: z.enum(["start", "end"]), date, half }),
  cmd("setDuration", { id, duration: halfDays }),
  cmd("setActualDuration", { id, days: halfDays.nullable() }),
  cmd("convertMilestone", { id, milestone: z.boolean() }),
  cmd("setLocked", { id, locked: z.boolean() }),
  addLink,
  cmd("updateLink", { predecessorId: id, followerId: id, kind: linkKind, lag: lag.optional(), newKind: linkKind.optional(), reverse: z.boolean().optional() }),
  removeLink,
  cmd("relink", { steps: z.array(z.discriminatedUnion("type", [setTarget, addLink, removeLink])).length(2) }),
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
