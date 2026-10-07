import { fromDay } from "@ganttlines/engine";
import type { RowChange } from "@ganttlines/engine";
import { z } from "zod";
import type { OutlineRow } from "../projects/project-service";
import { pickPerson, pickProject, ToolProblem } from "./lookup";
import { answer, guarded, type ToolContext, type ToolGroup } from "./tools";

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");

/** A board row as the AI sees it: dates computed, people and predecessors by id and name. */
export function describeRow({ row, depth, isParent, span, violation }: OutlineRow, names: { people: Map<string, string>; rows: Map<string, string> }) {
  const base = { id: row.id, title: row.title, depth, parentId: row.parentId };
  if (row.kind === "section") return { ...base, type: "section" as const };
  return {
    ...base,
    type: isParent ? ("parent task" as const) : row.duration === 0 ? ("milestone" as const) : ("task" as const),
    start: span ? fromDay(span.start) : null,
    end: span ? fromDay(span.end) : null,
    ...(span?.startsAfternoon ? { startsAfternoon: true } : {}),
    ...(span?.endsMidday ? { endsMidday: true } : {}),
    ...(isParent ? {} : { durationDays: row.duration }),
    assignee: row.resourceId ? { id: row.resourceId, name: names.people.get(row.resourceId) ?? "Unknown" } : null,
    predecessor: row.predecessorId ? { id: row.predecessorId, title: names.rows.get(row.predecessorId) ?? "Unknown", lagDays: row.offset } : null,
    ...(row.locked ? { locked: true } : {}),
    ...(violation ? { startsTooEarly: true } : {}),
    ...(row.actualDuration !== null ? { actualDurationDays: row.actualDuration } : {}),
    color: row.color,
    ...(row.description ? { description: row.description } : {}),
  };
}

async function peopleNames({ context }: ToolContext) {
  return new Map((await context.instance.resources()).map((person) => [person.id, person.name]));
}

async function projectsOf({ context }: ToolContext, includeArchived = false) {
  return context.db.project.findMany({ where: includeArchived ? {} : { archivedAt: null }, orderBy: { createdAt: "asc" } });
}

/** Reading projects: the list, one board, a search across boards, and a board's history. */
export const readPlans: ToolGroup = (server, tools) => {
  const { context } = tools;

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "Lists the projects (boards) with their date range and number of tasks. Archived projects are left out unless asked for.",
      inputSchema: z.object({ includeArchived: z.boolean().optional().describe("also list archived projects") }),
      annotations: { readOnlyHint: true },
    },
    ({ includeArchived }) =>
      guarded(async () => {
        const projects = [];
        for (const project of await projectsOf(tools, includeArchived)) {
          const { rows } = await context.projects.outline(project.id);
          const spans = rows.flatMap((entry) => (entry.span && entry.row.kind === "task" ? [entry.span] : []));
          projects.push({
            id: project.id,
            name: project.name,
            archived: project.archivedAt !== null,
            tasks: rows.filter((entry) => entry.row.kind === "task").length,
            start: spans.length ? fromDay(Math.min(...spans.map((span) => span.start))) : null,
            end: spans.length ? fromDay(Math.max(...spans.map((span) => span.end))) : null,
          });
        }
        return answer(`${projects.length} ${projects.length === 1 ? "project" : "projects"}.`, { projects });
      }),
  );

  server.registerTool(
    "get_project",
    {
      title: "Read a project",
      description:
        "Reads one project's board in order: sections, tasks (with sub-tasks by depth), milestones, computed start/end dates, durations in working days, assignees, predecessors (with lag in working days) and descriptions. Dates are YYYY-MM-DD; a task can start in the afternoon or end at midday.",
      inputSchema: z.object({ project: z.string().min(1).describe("the project's id or name") }),
      annotations: { readOnlyHint: true },
    },
    ({ project: ref }) =>
      guarded(async () => {
        const project = pickProject(await projectsOf(tools, true), ref);
        const outline = await context.projects.outline(project.id);
        const names = { people: await peopleNames(tools), rows: new Map(outline.rows.map((entry) => [entry.row.id, entry.row.title])) };
        const rows = outline.rows.map((entry) => describeRow(entry, names));
        const tasks = outline.rows.filter((entry) => entry.row.kind === "task").length;
        return answer(`“${project.name}”: ${tasks} ${tasks === 1 ? "task" : "tasks"}${project.archivedAt ? " (archived)" : ""}.`, {
          project: { id: project.id, name: project.name, archived: project.archivedAt !== null },
          rows,
        });
      }),
  );

  server.registerTool(
    "find_tasks",
    {
      title: "Find tasks",
      description:
        "Searches tasks across projects by words in the title or description, by assignee, and/or by dates (tasks overlapping from–to). For example: what is Ana doing next week?",
      inputSchema: z.object({
        text: z.string().optional().describe("words in the title or description"),
        assignee: z.string().optional().describe("a team member's id or name"),
        from: ISO_DATE.optional().describe("tasks ending on or after this date"),
        to: ISO_DATE.optional().describe("tasks starting on or before this date"),
        project: z.string().optional().describe("only this project (id or name)"),
        includeArchived: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    (input) =>
      guarded(async () => {
        if (input.from && input.to && input.from > input.to) throw new ToolProblem("“from” is after “to”.");
        const all = await projectsOf(tools, input.includeArchived || input.project !== undefined);
        const projects = input.project ? [pickProject(all, input.project)] : all;
        const people = await context.instance.resources();
        const assignee = input.assignee ? pickPerson(people, input.assignee) : null;
        const needle = input.text?.trim().toLocaleLowerCase() ?? "";
        const names = { people: new Map(people.map((person) => [person.id, person.name])), rows: new Map<string, string>() };
        const found = [];
        for (const project of projects) {
          const { rows } = await context.projects.outline(project.id);
          for (const entry of rows) names.rows.set(entry.row.id, entry.row.title);
          for (const entry of rows) {
            const { row, span } = entry;
            if (row.kind !== "task" || entry.isParent) continue;
            if (assignee && row.resourceId !== assignee.id) continue;
            if (needle && !`${row.title}\n${row.description}`.toLocaleLowerCase().includes(needle)) continue;
            if ((input.from || input.to) && !span) continue;
            if (input.from && span && fromDay(span.end) < input.from) continue;
            if (input.to && span && fromDay(span.start) > input.to) continue;
            found.push({ project: { id: project.id, name: project.name }, ...describeRow(entry, names) });
          }
        }
        const shown = found.slice(0, 200);
        return answer(`${found.length} ${found.length === 1 ? "task" : "tasks"} found${found.length > shown.length ? ` (first ${shown.length} shown)` : ""}.`, {
          tasks: shown,
        });
      }),
  );

  server.registerTool(
    "get_recent_changes",
    {
      title: "Recent changes to a project",
      description: "Lists a project's latest changes, newest first: when, who, what kind of change, and which tasks it touched.",
      inputSchema: z.object({
        project: z.string().min(1).describe("the project's id or name"),
        limit: z.number().int().min(1).max(100).optional().describe("how many changes (default 20)"),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ project: ref, limit = 20 }) =>
      guarded(async () => {
        const project = pickProject(await projectsOf(tools, true), ref);
        const { rows } = await context.projects.outline(project.id);
        const titles = new Map(rows.map((entry) => [entry.row.id, entry.row.title]));
        const entries = await context.db.commandLog.findMany({ where: { projectId: project.id }, orderBy: { version: "desc" }, take: limit });
        const changes = entries.map((entry) => ({
          at: entry.createdAt.toISOString(),
          by: entry.actorLabel,
          change: entry.name,
          tasks: [...new Set((entry.changes as unknown as RowChange[]).map((change) => change.rowId))].map((id) => titles.get(id) ?? "(deleted)"),
        }));
        return answer(`${changes.length} recent ${changes.length === 1 ? "change" : "changes"} to “${project.name}”.`, { changes });
      }),
  );
};
