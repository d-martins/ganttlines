import type { Row } from "@ganttlines/engine";
import type { BaselineTaskDto, CalendarDto, HighlightDto, HolidayDto, LocationDto, TimeOffDto } from "@ganttlines/protocol";
import { ApiError } from "../api";

/** The workspace file's — and the stored records' — format. */
export const WORKSPACE_FORMAT = "ganttlines-workspace";
export const WORKSPACE_VERSION = 1;

export interface StoredResource {
  id: string;
  name: string;
  avatarColor: string;
  inactive: boolean;
  locationId: string | null;
}

/** A holiday as stored: whom it targets (everyone, people, locations); who that is today is worked out on read. */
export interface StoredHoliday {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  appliesToAll: boolean;
  resourceIds: string[];
  locationIds: string[];
}

export interface StoredBaseline {
  id: string;
  name: string;
  createdAt: string;
  createdBy: string;
  tasks: BaselineTaskDto[];
}

/** A local workspace's team calendar (one record). */
export interface WorkspaceRecord {
  format: typeof WORKSPACE_FORMAT;
  version: number;
  instanceVersion: number;
  workingWeekdays: number[];
  team: StoredResource[];
  locations: LocationDto[];
  holidays: StoredHoliday[];
  timeOff: TimeOffDto[];
}

/** One project of a local workspace (one record each). */
export interface ProjectRecord {
  id: string;
  name: string;
  archived: boolean;
  createdAt: string;
  version: number;
  rows: Row[];
  highlights: HighlightDto[];
  baselines: StoredBaseline[];
}

export const emptyWorkspace = (): WorkspaceRecord => ({
  format: WORKSPACE_FORMAT,
  version: WORKSPACE_VERSION,
  instanceVersion: 1,
  workingWeekdays: [1, 2, 3, 4, 5],
  team: [],
  locations: [],
  holidays: [],
  timeOff: [],
});

/**
 * Checks a stored or imported workspace's format and version. There is one version so far; when a
 * second comes, older ones are upgraded here. Newer ones are refused — never half-read.
 */
export function checkFormat(value: { format?: unknown; version?: unknown }): void {
  if (value.format !== WORKSPACE_FORMAT || typeof value.version !== "number") throw new ApiError(400, "invalid_file", "This isn't a GanttLines workspace");
  if (value.version > WORKSPACE_VERSION) {
    throw new ApiError(400, "newer_version", "This workspace was saved by a newer version of GanttLines — update GanttLines to open it");
  }
}

const byStart = (a: { startDate: string; id: string }, b: { startDate: string; id: string }) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id);

/** The team calendar as the server would answer it (a location holiday applies to whoever is in that location now). */
export function toCalendarDto(workspace: WorkspaceRecord): CalendarDto {
  const inLocation = new Map<string, string[]>();
  for (const person of workspace.team) if (person.locationId) inLocation.set(person.locationId, [...(inLocation.get(person.locationId) ?? []), person.id]);
  return {
    instanceVersion: workspace.instanceVersion,
    workingWeekdays: [...workspace.workingWeekdays],
    holidays: [...workspace.holidays].sort(byStart).map(
      (holiday): HolidayDto => ({
        id: holiday.id,
        name: holiday.name,
        startDate: holiday.startDate,
        endDate: holiday.endDate,
        appliesTo: holiday.appliesToAll ? "all" : [...new Set([...holiday.resourceIds, ...holiday.locationIds.flatMap((id) => inLocation.get(id) ?? [])])],
        target: { all: holiday.appliesToAll, resourceIds: [...holiday.resourceIds], locationIds: [...holiday.locationIds] },
      }),
    ),
    timeOff: [...workspace.timeOff].sort(byStart).map((entry) => ({ ...entry })),
    locations: [...workspace.locations].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).map((location) => ({ ...location })),
  };
}
