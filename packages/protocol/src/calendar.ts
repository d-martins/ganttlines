import { MAX_DATE, MIN_DATE, toDay, type Holiday, type TimeOff } from "@ganttlines/engine";
import { z } from "zod";
import { LIMITS } from "./api";

/** Longest single holiday / time-off entry (longer absences: mark the team member inactive). */
export const MAX_RANGE_DAYS = 366;

/** Upper bounds on stored calendar entries (the engine expands them into day sets). */
export const CALENDAR_LIMITS = { holidays: 1_000, timeOff: 5_000 } as const;

const date = z.iso.date().refine((value) => value >= MIN_DATE && value <= MAX_DATE, `Dates must be between ${MIN_DATE} and ${MAX_DATE}`);
const name = z.string().trim().min(1).max(LIMITS.nameMax);
const color = z.string().regex(/^#[0-9a-f]{6}$/i, "Colors are #rrggbb");

/** Date ranges must not be reversed and must span at most MAX_RANGE_DAYS days (inclusive). */
export function checkRange(value: { startDate: string; endDate: string }, ctx: z.RefinementCtx): void {
  if (value.endDate < value.startDate) {
    ctx.addIssue({ code: "custom", message: "The end date is before the start date", path: ["endDate"] });
  } else if (toDay(value.endDate) - toDay(value.startDate) >= MAX_RANGE_DAYS) {
    ctx.addIssue({ code: "custom", message: `A single entry can span at most ${MAX_RANGE_DAYS} days`, path: ["endDate"] });
  }
}

export const CreateResourceBody = z.strictObject({ name, avatarColor: color.optional() });
export const UpdateResourceBody = z.strictObject({
  name: name.optional(),
  avatarColor: color.optional(),
  inactive: z.boolean().optional(),
  /** where they work (null: no location) */
  locationId: z.uuid().nullable().optional(),
});
/** ISO 3166-1 country code ("PT") and a region code within it ("BY"), for public holidays. */
const country = z.string().regex(/^[A-Z]{2}$/, "Use a two-letter country code");
const region = z.string().regex(/^[A-Z0-9]{1,6}$/i, "Use a region code");
export const LocationBody = z.strictObject({ name, country: country.nullable().default(null), region: region.nullable().default(null) });
/** Public holidays to add to a location (picked from the suggested list; still editable afterwards). */
export const ImportHolidaysBody = z.strictObject({
  holidays: z
    .array(z.strictObject({ name, startDate: date, endDate: date }).superRefine(checkRange))
    .min(1)
    .max(100),
});
export const WorkingWeekdaysBody = z.strictObject({
  workingWeekdays: z.array(z.int().min(0).max(6)).min(1).max(7).refine((days) => new Set(days).size === days.length, "Duplicate weekday"),
});
/** A holiday for everyone, or for some people and/or everyone in some locations. */
export const HolidayBody = z
  .strictObject({
    name,
    startDate: date,
    endDate: date,
    appliesTo: z.union([z.literal("all"), z.array(z.uuid()).max(1000)]),
    locationIds: z.array(z.uuid()).max(100).default([]),
  })
  .superRefine(checkRange)
  .superRefine((value, ctx) => {
    if (value.appliesTo !== "all" && value.appliesTo.length === 0 && value.locationIds.length === 0) {
      ctx.addIssue({ code: "custom", message: "Choose who the holiday is for", path: ["appliesTo"] });
    }
  });
export const TimeOffBody = z
  .strictObject({ resourceId: z.uuid(), startDate: date, endDate: date, note: z.string().max(500).default("") })
  .superRefine(checkRange);

export type CreateResourceBody = z.infer<typeof CreateResourceBody>;
export type UpdateResourceBody = z.infer<typeof UpdateResourceBody>;
export type WorkingWeekdaysBody = z.infer<typeof WorkingWeekdaysBody>;
export type HolidayBody = z.input<typeof HolidayBody>;
export type LocationBody = z.input<typeof LocationBody>;
export type ImportHolidaysBody = z.infer<typeof ImportHolidaysBody>;
export type TimeOffBody = z.input<typeof TimeOffBody>;

export interface ResourceDto {
  id: string;
  name: string;
  avatarColor: string;
  inactive: boolean;
  userId: string | null;
  locationId: string | null;
}

export interface LocationDto {
  id: string;
  name: string;
  country: string | null;
  region: string | null;
}

/**
 * A holiday as the engine schedules it (`appliesTo`: everyone, or the people it currently covers —
 * including everyone in its locations) plus what it was set up for, for editing.
 */
export interface HolidayDto extends Holiday {
  target: { all: boolean; resourceIds: string[]; locationIds: string[] };
}

/** A public holiday suggested for a location (from the date-holidays data, CC BY-SA 3.0). */
export interface PublicHolidayDto {
  name: string;
  startDate: string;
  endDate: string;
  /** "public" (days off by law), "bank", "optional", "school" or "observance" */
  type: string;
  /** already added to this location */
  added: boolean;
}

export interface TimeOffDto extends TimeOff {
  note: string;
}

/** Response of GET /api/calendar — the instance-wide calendar every project schedules against. */
export interface CalendarDto {
  instanceVersion: number;
  workingWeekdays: number[];
  holidays: HolidayDto[];
  timeOff: TimeOffDto[];
  locations: LocationDto[];
}
