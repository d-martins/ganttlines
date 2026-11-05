import { Calendar, findLinkProblem, findTreeProblem, hasCycle, linkKey, toDay, type ProjectState, type Row } from "@ganttlines/engine";
import type { WorkspaceFile, WorkspaceFileV1, WorkspaceFileV2, WorkspaceFileV3 } from "@ganttlines/protocol";
import { ApiError } from "../api";
import { checkFormat, toCalendarDto, WORKSPACE_FORMAT, WORKSPACE_VERSION } from "./records";
import { upgradeProjectRecord } from "./upgrade";
import { validation } from "./validation";

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/**
 * The team calendar is worked out per person and day: a file whose holidays and time off add up to
 * more person-days than this is refused before anything is computed (a whole team's real calendar
 * stays far below it).
 */
export const MAX_PERSON_DAYS = 2_000_000;

const invalid = (message: string) => new ApiError(400, "invalid_file", message);

/**
 * Reads a workspace file and checks everything — shape, references, outlines, links, dependency
 * loops — before anything is changed. An older file (version 1 to 3) is upgraded. Throws `ApiError` 400 with the reason.
 */
export async function readWorkspaceFile(text: string): Promise<WorkspaceFile> {
  if (text.length > MAX_FILE_BYTES) throw invalid("This file is too big (over 50 MB)");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw invalid("This isn't a GanttLines workspace file");
  }
  if (typeof json !== "object" || json === null) throw invalid("This isn't a GanttLines workspace file");
  checkFormat(json as { format?: unknown; version?: unknown });
  const { protocol, explain } = await validation();
  const version = (json as { version: number }).version;
  const schema = version === 1 ? protocol.WorkspaceFileV1 : version === 2 ? protocol.WorkspaceFileV2 : version === 3 ? protocol.WorkspaceFileV3 : protocol.WorkspaceFile;
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw invalid(`This file can't be opened: ${explain(parsed.error)}`);
  const file = parsed.data.version === WORKSPACE_VERSION ? parsed.data : upgradeFile(parsed.data);
  const problem = referenceProblem(file);
  if (problem) throw invalid(`This file can't be opened: ${problem}`);
  return file;
}

function upgradeFile(file: WorkspaceFileV1 | WorkspaceFileV2 | WorkspaceFileV3): WorkspaceFile {
  return { ...file, version: WORKSPACE_VERSION, projects: file.projects.map((project) => upgradeProjectRecord(project) as WorkspaceFile["projects"][number]) };
}

/** The first id used twice within a collection (or across projects' rows), if any. */
function duplicateProblem(file: WorkspaceFile): string | null {
  const twice = (what: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) return `${what} ${id} appears twice`;
      seen.add(id);
    }
    return null;
  };
  return (
    twice("project", file.projects.map((project) => project.id)) ??
    twice("team member", file.team.map((person) => person.id)) ??
    twice("location", file.locations.map((location) => location.id)) ??
    twice("holiday", file.holidays.map((holiday) => holiday.id)) ??
    twice("time off", file.timeOff.map((entry) => entry.id)) ??
    twice("row", file.projects.flatMap((project) => project.rows.map((row) => row.id))) ??
    twice("link", file.projects.flatMap((project) => project.links.map(linkKey))) ??
    twice("highlight", file.projects.flatMap((project) => project.highlights.map((highlight) => highlight.id))) ??
    twice("baseline", file.projects.flatMap((project) => project.baselines.map((baseline) => baseline.id)))
  );
}

function referenceProblem(file: WorkspaceFile): string | null {
  const duplicate = duplicateProblem(file);
  if (duplicate) return duplicate;
  const people = new Set(file.team.map((person) => person.id));
  const places = new Set(file.locations.map((location) => location.id));
  for (const person of file.team) if (person.locationId && !places.has(person.locationId)) return `team member “${person.name}” is in a location that isn't there`;
  for (const holiday of file.holidays) {
    if (holiday.resourceIds.some((id) => !people.has(id))) return `holiday “${holiday.name}” is for a team member who isn't there`;
    if (holiday.locationIds.some((id) => !places.has(id))) return `holiday “${holiday.name}” is for a location that isn't there`;
  }
  if (file.timeOff.some((entry) => !people.has(entry.resourceId))) return "some time off is for a team member who isn't there";
  const days = (entry: { startDate: string; endDate: string }) => toDay(entry.endDate) - toDay(entry.startDate) + 1;
  const inLocation = new Map<string, number>();
  for (const person of file.team) if (person.locationId) inLocation.set(person.locationId, (inLocation.get(person.locationId) ?? 0) + 1);
  let personDays = file.timeOff.reduce((total, entry) => total + days(entry), 0);
  for (const holiday of file.holidays) {
    const covered = holiday.appliesToAll ? 1 : holiday.resourceIds.length + holiday.locationIds.reduce((total, id) => total + (inLocation.get(id) ?? 0), 0);
    personDays += days(holiday) * covered;
  }
  if (personDays > MAX_PERSON_DAYS) return "its team calendar is too large (too many long holidays and time off for too many people)";
  let calendar: Calendar;
  try {
    calendar = new Calendar({ ...toCalendarDto({ ...file, format: WORKSPACE_FORMAT, version: WORKSPACE_VERSION, instanceVersion: 1 }) });
  } catch (error) {
    return `the team calendar isn't valid (${(error as Error).message})`;
  }
  for (const project of file.projects) {
    const rows = project.rows as Row[];
    const structure = findTreeProblem(rows) ?? findLinkProblem(rows, project.links);
    if (structure) return `project “${project.name}”: ${structure}`;
    const ghost = rows.find((row) => row.kind === "task" && row.resourceId !== null && !people.has(row.resourceId));
    if (ghost) return `project “${project.name}”: “${ghost.title}” is assigned to a team member who isn't there`;
    const byId = new Map(rows.map((row) => [row.id, row]));
    const astray = rows.find((row) => {
      if (row.kind !== "task" || row.targetId === null) return false;
      const target = byId.get(row.targetId);
      return target?.kind !== "task" || target.duration !== 0 || rows.some((other) => other.parentId === target.id);
    });
    if (astray) return `project “${project.name}”: “${astray.title}” aims for something that isn't a milestone on this board`;
    const state: ProjectState = { rows: Object.fromEntries(rows.map((row) => [row.id, row])), links: Object.fromEntries(project.links.map((link) => [linkKey(link), link])) };
    if (hasCycle(state, calendar)) return `project “${project.name}” has tasks that depend on each other in a loop`;
  }
  return null;
}
