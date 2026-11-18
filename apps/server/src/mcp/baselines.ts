import { toDay } from "@ganttlines/engine";
import type { Baseline } from "@ganttlines/db";
import { CreateBaselineBody } from "@ganttlines/protocol";
import { z } from "zod";
import { aiActorOf } from "../actor";
import { deleteBaseline, listBaselines, readBaseline, saveBaseline } from "../routes/baselines";
import { pickOne, pickProject, ToolProblem } from "./lookup";
import { answer, guarded, type ToolContext } from "./tools";
import type { McpServer } from "@modelcontextprotocol/server";

const BASELINE_REF = z.string().min(1).describe("the baseline's id or name");

async function projectFor({ context }: ToolContext, ref: string, includeArchived: boolean) {
  const projects = await context.db.project.findMany({ where: includeArchived ? {} : { archivedAt: null }, orderBy: { createdAt: "asc" } });
  return pickProject(projects, ref);
}

async function baselineFor({ context }: ToolContext, projectId: string, ref: string): Promise<Baseline> {
  const baselines = await context.db.baseline.findMany({ where: { projectId }, orderBy: { createdAt: "desc" } });
  if (baselines.length === 0) throw new ToolProblem("This project has no baselines yet.");
  return pickOne(baselines, ref, (baseline) => baseline.id, (baseline) => baseline.name, "baseline");
}

/** (baselines saved before half days have no half-day flags) */
const dates = (task: { start: string; end: string; startsAfternoon?: boolean | undefined; endsMidday?: boolean | undefined }) => ({
  start: task.start,
  end: task.end,
  ...(task.startsAfternoon ? { startsAfternoon: true } : {}),
  ...(task.endsMidday ? { endsMidday: true } : {}),
});

/** Reading baselines (saved copies of a board's dates): the list, and one beside the board as it is now. */
export function readBaselines(server: McpServer, tools: ToolContext): void {
  const { context } = tools;

  server.registerTool(
    "list_baselines",
    {
      title: "List baselines",
      description: "Lists a project's baselines (saved copies of its task dates, to compare the plan against), newest first.",
      inputSchema: z.object({ project: z.string().min(1).describe("the project's id or name") }),
      annotations: { readOnlyHint: true },
    },
    ({ project: ref }) =>
      guarded(async () => {
        const project = await projectFor(tools, ref, true);
        const baselines = await listBaselines(context.db, project.id);
        return answer(`“${project.name}”: ${baselines.length} ${baselines.length === 1 ? "baseline" : "baselines"}.`, { baselines });
      }),
  );

  server.registerTool(
    "get_baseline",
    {
      title: "Compare with a baseline",
      description:
        "Reads one baseline beside the board as it is now: each task's saved and current dates (YYYY-MM-DD), and how many working days its start and end have moved (positive is later). Also lists tasks added since the baseline and tasks it has that are gone.",
      inputSchema: z.object({ project: z.string().min(1).describe("the project's id or name"), baseline: BASELINE_REF }),
      annotations: { readOnlyHint: true },
    },
    ({ project: ref, baseline: baselineRef }) =>
      guarded(async () => {
        const project = await projectFor(tools, ref, true);
        const { baseline, tasks: saved } = readBaseline(await baselineFor(tools, project.id, baselineRef));
        const now = await context.projects.scheduleSnapshot(project.id);
        const { calendar } = await context.instance.current();
        const moved = (from: string, to: string) => calendar.workingDaysBetween(toDay(from), toDay(to), null);
        const current = new Map(now.map((task) => [task.rowId, task]));
        const kept = new Set(saved.map((task) => task.rowId));
        const tasks = saved.flatMap((task) => {
          const today = current.get(task.rowId);
          if (!today) return [];
          return [
            {
              id: task.rowId,
              title: today.title,
              kind: today.kind,
              saved: dates(task),
              now: dates(today),
              startMovedDays: moved(task.start, today.start),
              endMovedDays: moved(task.end, today.end),
            },
          ];
        });
        const addedSince = now.filter((task) => !kept.has(task.rowId)).map((task) => ({ id: task.rowId, title: task.title, now: dates(task) }));
        const removedSince = saved.filter((task) => !current.has(task.rowId)).map((task) => ({ id: task.rowId, title: task.title, saved: dates(task) }));
        const late = tasks.filter((task) => task.endMovedDays > 0).length;
        return answer(`“${baseline.name}” (${baseline.createdAt.slice(0, 10)}): ${tasks.length} tasks compared, ${late} ${late === 1 ? "ends" : "end"} later than saved.`, {
          baseline,
          tasks,
          addedSince,
          removedSince,
        });
      }),
  );
}

/** Saving and deleting baselines, as the person who connected the app (shown “via” it). */
export function writeBaselines(server: McpServer, tools: ToolContext): void {
  const { context, caller } = tools;

  server.registerTool(
    "save_baseline",
    {
      title: "Save a baseline",
      description: "Saves the project's current task dates as a named baseline, to compare the plan against later (the board can show it too).",
      inputSchema: z.object({ project: z.string().min(1).describe("the project's id or name"), name: z.string().min(1).describe("a name for the baseline") }),
    },
    ({ project: ref, name }) =>
      guarded(async () => {
        const body = CreateBaselineBody.safeParse({ name });
        if (!body.success) throw new ToolProblem(z.prettifyError(body.error));
        const project = await projectFor(tools, ref, false);
        const baseline = await saveBaseline(context, project.id, body.data.name, aiActorOf(caller.user, caller.app, caller.connectionId));
        return answer(`Saved the baseline “${baseline.name}” of “${project.name}”.`, { baseline });
      }),
  );

  server.registerTool(
    "delete_baseline",
    {
      title: "Delete a baseline",
      description: "Deletes one of a project's baselines. This can't be undone.",
      inputSchema: z.object({ project: z.string().min(1).describe("the project's id or name"), baseline: BASELINE_REF }),
      annotations: { destructiveHint: true },
    },
    ({ project: ref, baseline: baselineRef }) =>
      guarded(async () => {
        const project = await projectFor(tools, ref, true);
        const baseline = await baselineFor(tools, project.id, baselineRef);
        await deleteBaseline(context, baseline);
        return answer(`Deleted the baseline “${baseline.name}” of “${project.name}”.`, { deleted: { id: baseline.id, name: baseline.name } });
      }),
  );
}
