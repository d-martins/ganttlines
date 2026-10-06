import { Calendar, findTreeProblem, hasCycle, type ProjectState, type Row } from "@ganttlines/engine";
import type { WorkspaceFile } from "@ganttlines/protocol";
import { ApiError } from "../api";
import { checkFormat, toCalendarDto, WORKSPACE_FORMAT, WORKSPACE_VERSION } from "./records";
import { validation } from "./validation";

export const MAX_FILE_BYTES = 50 * 1024 * 1024;

const invalid = (message: string) => new ApiError(400, "invalid_file", message);

/**
 * Reads a workspace file and checks everything — shape, references, outlines, dependency loops —
 * before anything is changed. Throws `ApiError` 400 with the reason.
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
  const parsed = protocol.WorkspaceFile.safeParse(json);
  if (!parsed.success) throw invalid(`This file can't be opened: ${explain(parsed.error)}`);
  const problem = referenceProblem(parsed.data);
  if (problem) throw invalid(`This file can't be opened: ${problem}`);
  return parsed.data;
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
  let calendar: Calendar;
  try {
    calendar = new Calendar({ ...toCalendarDto({ ...file, format: WORKSPACE_FORMAT, version: WORKSPACE_VERSION, instanceVersion: 1 }) });
  } catch (error) {
    return `the team calendar isn't valid (${(error as Error).message})`;
  }
  for (const project of file.projects) {
    const rows = project.rows as Row[];
    const tree = findTreeProblem(rows);
    if (tree) return `project “${project.name}”: ${tree}`;
    const ghost = rows.find((row) => row.kind === "task" && row.resourceId !== null && !people.has(row.resourceId));
    if (ghost) return `project “${project.name}”: “${ghost.title}” is assigned to a team member who isn't there`;
    const state: ProjectState = { rows: Object.fromEntries(rows.map((row) => [row.id, row])) };
    if (hasCycle(state, calendar)) return `project “${project.name}” has tasks that depend on each other in a loop`;
  }
  return null;
}
