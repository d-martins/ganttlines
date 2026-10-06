import { MAX_DATE, MAX_DURATION, MAX_OFFSET, MIN_DATE, TASK_COLORS } from "@ganttlines/engine";
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

const SectionRow = z.strictObject({ id, kind: z.literal("section"), title: z.string().max(COMMAND_LIMITS.titleMax), parentId: id.nullable(), position });
const TaskRow = z.strictObject({
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
  predecessorId: id.nullable(),
  offset: halfSteps(z.number().min(-MAX_OFFSET).max(MAX_OFFSET)),
  description: z.string().max(COMMAND_LIMITS.descriptionMax),
});

/** A whole local workspace, as exported to (and imported from) a `.ganttlines.json` file. */
export const WorkspaceFile = z.strictObject({
  format: z.literal("ganttlines-workspace"),
  version: z.literal(1),
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
  projects: z
    .array(
      z.strictObject({
        id,
        name: projectName,
        archived: z.boolean(),
        createdAt: z.string().max(40),
        version: z.int().min(0),
        rows: z.array(z.discriminatedUnion("kind", [SectionRow, TaskRow])).max(20_000),
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
      }),
    )
    .max(1_000),
});
export type WorkspaceFile = z.infer<typeof WorkspaceFile>;
