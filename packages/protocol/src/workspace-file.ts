import { MAX_DATE, MAX_DURATION, MAX_LAG, MAX_TAG_LENGTH, MAX_TAGS_PER_TASK, MIN_DATE, TASK_COLORS, tagKey } from "@ganttlines/engine";
import { z } from "zod";
import { CALENDAR_LIMITS, checkRange } from "./calendar";
import { LIMITS } from "./api";
import { BOARD_LIMITS, COMMAND_LIMITS } from "./constants";

const id = z.uuid();
const date = z.iso.date().refine((value) => value >= MIN_DATE && value <= MAX_DATE, `Dates must be between ${MIN_DATE} and ${MAX_DATE}`);
const name = z.string().trim().min(1).max(LIMITS.nameMax);
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
const halfSteps = (schema: z.ZodNumber) => schema.refine((value) => Number.isInteger(value * 2), "Use whole or half days");
// Order keys grow when rows keep being inserted at the same place; the app sets no limit.
const position = z.string().min(1).max(10_000);
const projectName = z.string().trim().min(1).max(LIMITS.projectNameMax);

const sectionFields = { id, kind: z.literal("section"), title: z.string().max(COMMAND_LIMITS.titleMax), parentId: id.nullable(), position };
const SectionRow = z.strictObject({ ...sectionFields, description: z.string().max(COMMAND_LIMITS.descriptionMax) });
// Before v3, sections had no description and tasks no tags.
const SectionRowV2 = z.strictObject(sectionFields);
const taskFields = {
  id,
  kind: z.literal("task"),
  title: z.string().max(COMMAND_LIMITS.titleMax),
  parentId: id.nullable(),
  position,
  userStart: date.nullable(),
  startsAfternoon: z.boolean(),
  duration: halfSteps(z.number().min(0).max(MAX_DURATION)),
  actualDuration: halfSteps(z.number().min(0.5).max(MAX_DURATION)).nullable(),
  resourceId: id.nullable(),
  color: z.enum(TASK_COLORS),
  locked: z.boolean(),
  description: z.string().max(COMMAND_LIMITS.descriptionMax),
};
// Stored tags are already tidy: trimmed, non-empty, one per spelling.
const tags = z
  .array(z.string().min(1).max(MAX_TAG_LENGTH).refine((tag) => tag === tag.trim(), "Tags have no surrounding spaces"))
  .max(MAX_TAGS_PER_TASK)
  .refine((list) => new Set(list.map(tagKey)).size === list.length, "A task has each tag once");
const TaskRow = z.strictObject({ ...taskFields, tags });
const TaskRowV2 = z.strictObject(taskFields);
// v1 files kept a task's single predecessor and its offset on the row.
const TaskRowV1 = z.strictObject({
  ...taskFields,
  predecessorId: id.nullable(),
  offset: halfSteps(z.number().min(-MAX_LAG).max(MAX_LAG)),
});
const LinkRecord = z.strictObject({ predecessorId: id, followerId: id, kind: z.enum(["FS", "SS", "FF", "SF"]), lag: halfSteps(z.number().min(-MAX_LAG).max(MAX_LAG)) });

const workspaceFields = {
  format: z.literal("ganttlines-workspace"),
  exportedAt: z.string().max(40),
  workingWeekdays: z
    .array(z.int().min(0).max(6))
    .min(1)
    .max(7)
    .refine((days) => new Set(days).size === days.length, "Duplicate weekday"),
  team: z.array(z.strictObject({ id, name, avatarColor: color, inactive: z.boolean(), locationId: id.nullable() })).max(1_000),
  locations: z.array(z.strictObject({ id, name, country: z.string().regex(/^[A-Z]{2}$/).nullable(), region: z.string().max(20).nullable() })).max(1_000),
  holidays: z
    .array(
      z
        .strictObject({ id, name, startDate: date, endDate: date, appliesToAll: z.boolean(), resourceIds: z.array(id).max(1_000), locationIds: z.array(id).max(100) })
        .superRefine(checkRange)
        .refine(
          (holiday) => (holiday.appliesToAll ? holiday.resourceIds.length + holiday.locationIds.length === 0 : holiday.resourceIds.length + holiday.locationIds.length > 0),
          "A holiday is for everyone, or for chosen people or locations",
        ),
    )
    .max(CALENDAR_LIMITS.holidays),
  timeOff: z.array(z.strictObject({ id, resourceId: id, startDate: date, endDate: date, note: z.string().max(500) }).superRefine(checkRange)).max(CALENDAR_LIMITS.timeOff),
};

const projectFields = {
  id,
  name: projectName,
  archived: z.boolean(),
  createdAt: z.string().max(40),
  version: z.int().min(0),
  highlights: z.array(z.strictObject({ id, date, label: z.string().max(BOARD_LIMITS.highlightLabelMax), color })).max(1_000),
  baselines: z
    .array(
      z.strictObject({
        id,
        name: z.string().trim().min(1).max(BOARD_LIMITS.baselineNameMax),
        createdAt: z.string().max(40),
        createdBy: z.string().max(200),
        tasks: z
          .array(
            z.strictObject({
              rowId: id,
              kind: z.enum(["task", "parent", "milestone"]),
              title: z.string().max(COMMAND_LIMITS.titleMax),
              // computed dates: a schedule can run past the last date anyone can type
              start: z.iso.date(),
              end: z.iso.date(),
              startsAfternoon: z.boolean().optional(),
              endsMidday: z.boolean().optional(),
            }),
          )
          .max(20_000),
      }),
    )
    .max(100),
};

/** A whole local workspace, as exported to (and imported from) a `.ganttlines.json` file. */
export const WorkspaceFile = z.strictObject({
  ...workspaceFields,
  version: z.literal(3),
  projects: z
    .array(
      z.strictObject({
        ...projectFields,
        rows: z.array(z.discriminatedUnion("kind", [SectionRow, TaskRow])).max(20_000),
        links: z.array(LinkRecord).max(100_000),
      }),
    )
    .max(1_000),
});
export type WorkspaceFile = z.infer<typeof WorkspaceFile>;

/** The format before tags and section descriptions, still accepted on import. */
export const WorkspaceFileV2 = z.strictObject({
  ...workspaceFields,
  version: z.literal(2),
  projects: z
    .array(
      z.strictObject({
        ...projectFields,
        rows: z.array(z.discriminatedUnion("kind", [SectionRowV2, TaskRowV2])).max(20_000),
        links: z.array(LinkRecord).max(100_000),
      }),
    )
    .max(1_000),
});
export type WorkspaceFileV2 = z.infer<typeof WorkspaceFileV2>;

/** The first file format (one predecessor kept on each task), still accepted on import. */
export const WorkspaceFileV1 = z.strictObject({
  ...workspaceFields,
  version: z.literal(1),
  projects: z
    .array(z.strictObject({ ...projectFields, rows: z.array(z.discriminatedUnion("kind", [SectionRowV2, TaskRowV1])).max(20_000) }))
    .max(1_000),
});
export type WorkspaceFileV1 = z.infer<typeof WorkspaceFileV1>;
