import { fromDay, spanStart as spanStartHalf, TASK_COLORS, type Command } from "@ganttlines/engine";
import type { Project } from "@ganttlines/db";
import { CommandSchema, CreateProjectBody, toEngineCommand } from "@ganttlines/protocol";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { aiActorOf, type Actor } from "../actor";
import { toProjectDto } from "../dto";
import { HttpError } from "../errors";
import type { OutlineRow } from "../projects/project-service";
import { pickOne, pickPerson, pickProject, ToolProblem } from "./lookup";
import { describeRow } from "./plans-read";
import { answer, guarded, type ToolContext, type ToolGroup } from "./tools";

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");
const HALF = z.enum(["morning", "afternoon"]).describe("start in the morning (default) or the afternoon of that day");
const DAYS = z.number().min(0).max(3660).multipleOf(0.5);
const MAX_TASKS_PER_CALL = 100;

/** The last tool call's board commands, kept on the connection so `undo` can revert exactly those. */
export interface LastCall {
  projectId: string;
  commandIds: string[];
}

/**
 * One tool call's edits to one board: commands go through the same checks, scheduling, history and
 * live updates as the web app's; those that changed something are remembered for `undo`.
 */
class BoardEdit {
  readonly commandIds: string[] = [];
  rows: OutlineRow[] = [];

  constructor(
    private readonly tools: ToolContext,
    readonly project: Project,
    readonly actor: Actor,
  ) {}

  async load(): Promise<void> {
    this.rows = (await this.tools.context.projects.outline(this.project.id)).rows;
  }

  async run(command: Command): Promise<void> {
    const parsed = CommandSchema.safeParse(command);
    if (!parsed.success) throw new ToolProblem(z.prettifyError(parsed.error));
    const commandId = randomUUID();
    const result = await this.tools.context.projects.apply(this.project.id, this.actor, commandId, toEngineCommand(parsed.data));
    if (result.changes.length > 0) this.commandIds.push(commandId);
  }

  /** A row of the board by id or title (`kinds` limits which), as the board has it now. */
  find(ref: string, kinds: "task" | "section" | "any" = "any", extra: readonly { id: string; title: string }[] = []) {
    const onBoard = this.rows.filter((entry) => kinds === "any" || entry.row.kind === kinds).map((entry) => ({ id: entry.row.id, title: entry.row.title }));
    // Rows added earlier in this call are usually on the board already; list each once.
    const candidates = [...onBoard, ...extra.filter((row) => !onBoard.some((other) => other.id === row.id) && !this.row(row.id))];
    return pickOne(candidates, ref, (row) => row.id, (row) => row.title, kinds === "section" ? "section" : kinds === "task" ? "task" : "section or task");
  }

  row(id: string) {
    return this.rows.find((entry) => entry.row.id === id);
  }

  /** Records what this call changed on the connection (replacing the previous call's). */
  async remember(): Promise<void> {
    if (this.commandIds.length === 0) return;
    const lastCall: LastCall = { projectId: this.project.id, commandIds: this.commandIds };
    await this.tools.context.db.mcpConnection.updateMany({ where: { id: this.tools.caller.connectionId }, data: { lastCall: { ...lastCall } } });
  }

  /** Runs the steps; on a failure, says how far it got (what was done stays, and can be undone). */
  async steps(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      await this.remember();
      if (!(error instanceof ToolProblem || error instanceof HttpError)) throw error;
      const done = this.commandIds.length;
      throw new ToolProblem(
        `${error.message}${done ? ` — stopped there. ${done} ${done === 1 ? "change" : "changes"} before it ${done === 1 ? "was" : "were"} made; call undo to revert ${done === 1 ? "it" : "them"}.` : ""}`,
      );
    }
    await this.remember();
  }

  /** The rows with these ids as they are now (dates computed). */
  async describe(ids: readonly string[]) {
    await this.load();
    const people = new Map((await this.tools.context.instance.resources()).map((person) => [person.id, person.name]));
    const names = { people, rows: new Map(this.rows.map((entry) => [entry.row.id, entry.row.title])) };
    const wanted = new Set(ids);
    return this.rows.filter((entry) => wanted.has(entry.row.id)).map((entry) => describeRow(entry, names));
  }
}

async function editProject(tools: ToolContext, ref: string): Promise<BoardEdit> {
  const projects = await tools.context.db.project.findMany({ where: { archivedAt: null }, orderBy: { createdAt: "asc" } });
  const project = pickProject(projects, ref);
  const edit = new BoardEdit(tools, project, aiActorOf(tools.caller.user, tools.caller.app, tools.caller.connectionId));
  await edit.load();
  return edit;
}

const TaskFields = {
  description: z.string().max(20_000).optional().describe("Markdown"),
  color: z.enum(TASK_COLORS).optional(),
  start: ISO_DATE.optional().describe("the day it starts (tasks with a predecessor are placed after it instead)"),
  half: HALF.optional(),
  durationDays: DAYS.optional().describe("working days, in half-day steps (default 1)"),
  assignee: z.string().nullable().optional().describe("a team member's id or name; null for nobody"),
  predecessor: z.string().nullable().optional().describe("the task (id or title) this one follows; null for none"),
  lagDays: z.number().min(-3660).max(3660).multipleOf(0.5).optional().describe("working days after the predecessor ends (negative overlaps)"),
  milestone: z.boolean().optional().describe("a milestone (zero length)"),
};

/** Editing plans: projects, and the tasks on their boards. */
export const writePlans: ToolGroup = (server, tools) => {
  const { context, caller } = tools;
  const people = async () => context.instance.resources();

  server.registerTool(
    "create_project",
    {
      title: "Create a project",
      description: "Creates an empty project (board). Add sections and tasks with add_tasks.",
      inputSchema: z.object({ name: z.string().min(1).max(200) }),
    },
    ({ name }) =>
      guarded(async () => {
        const body = CreateProjectBody.safeParse({ name });
        if (!body.success) throw new ToolProblem(z.prettifyError(body.error));
        const project = await context.db.project.create({ data: { name: body.data.name } });
        return answer(`Created the project “${project.name}”.`, { project: toProjectDto(project) });
      }),
  );

  server.registerTool(
    "rename_project",
    {
      title: "Rename a project",
      inputSchema: z.object({ project: z.string().min(1).describe("the project's id or name"), name: z.string().min(1).max(200) }),
    },
    ({ project: ref, name }) =>
      guarded(async () => {
        const project = pickProject(await context.db.project.findMany({ where: { archivedAt: null } }), ref);
        const updated = await context.projects.updateMeta(project.id, { name: name.trim() });
        return answer(`Renamed “${project.name}” to “${updated.name}”.`, { project: toProjectDto(updated) });
      }),
  );

  server.registerTool(
    "add_tasks",
    {
      title: "Add tasks",
      description:
        "Adds sections, tasks and milestones to a project, in order. Each can go in a section or under a parent task (by id or title — " +
        "including ones added earlier in the same call), start on a date or follow a predecessor, and have a duration in working days " +
        "and an assignee. Tasks are scheduled around weekends, holidays and the assignee's time off. Returns the added rows with their computed dates.",
      inputSchema: z.object({
        project: z.string().min(1).describe("the project's id or name"),
        tasks: z
          .array(
            z.object({
              title: z.string().min(1).max(500),
              kind: z.enum(["task", "section"]).optional().describe("default task"),
              parent: z.string().optional().describe("the section or parent task to put it in (id or title); default the top level"),
              after: z.string().optional().describe("the row (id or title) to place it after, within its parent; default at the end"),
              ...TaskFields,
            }),
          )
          .min(1)
          .max(MAX_TASKS_PER_CALL),
      }),
    },
    ({ project: ref, tasks }) =>
      guarded(async () => {
        const edit = await editProject(tools, ref);
        const team = await people();
        const added: { id: string; title: string }[] = [];
        await edit.steps(async () => {
          for (const item of tasks) {
            const kind = item.kind ?? "task";
            const parentId = item.parent ? edit.find(item.parent, "any", added).id : null;
            const siblings = edit.rows.filter((entry) => entry.row.parentId === parentId);
            const afterId = item.after ? edit.find(item.after, "any", added).id : (siblings[siblings.length - 1]?.row.id ?? null);
            const id = randomUUID();
            const predecessor = kind === "task" && item.predecessor ? edit.find(item.predecessor, "task", added) : null;
            // Linking needs both tasks scheduled: a follower starts wherever its predecessor does, then the link places it.
            const start = item.start ?? (predecessor ? (spanStart(edit, predecessor.id) ?? undefined) : undefined);
            await edit.run({ type: "createRow", id, kind, parentId, afterId, title: item.title, ...(start ? { start } : {}) });
            added.push({ id, title: item.title });
            await edit.load();
            if (kind === "section") continue;
            await applyTaskFields(edit, id, item, team, added, Boolean(start));
            await edit.load();
          }
        });
        const rows = await edit.describe(added.map((row) => row.id));
        return answer(`Added ${rows.length} ${rows.length === 1 ? "row" : "rows"} to “${edit.project.name}”.`, { project: edit.project.name, added: rows });
      }),
  );

  server.registerTool(
    "update_task",
    {
      title: "Change a task",
      description:
        "Changes one task: title, description, colour, assignee, start (and half day), duration, milestone, lock, predecessor and lag, " +
        "or the working days it actually took. Only the fields given change. Returns the task with its new dates.",
      inputSchema: z.object({
        project: z.string().min(1).describe("the project's id or name"),
        task: z.string().min(1).describe("the task's id or title"),
        title: z.string().min(1).max(500).optional(),
        locked: z.boolean().optional().describe("locked tasks keep their dates"),
        actualDurationDays: DAYS.nullable().optional().describe("the working days it really took (informational); null to clear"),
        ...TaskFields,
      }),
    },
    ({ project: ref, task: taskRef, ...fields }) =>
      guarded(async () => {
        const edit = await editProject(tools, ref);
        const task = edit.find(taskRef, "task");
        await edit.steps(async () => {
          if (fields.title !== undefined) await edit.run({ type: "updateTitle", id: task.id, title: fields.title });
          await applyTaskFields(edit, task.id, fields, await people(), [], false);
          if (fields.locked !== undefined) await edit.run({ type: "setLocked", id: task.id, locked: fields.locked });
          if (fields.actualDurationDays !== undefined) await edit.run({ type: "setActualDuration", id: task.id, days: fields.actualDurationDays });
        });
        const [row] = await edit.describe([task.id]);
        return answer(`Updated “${task.title}”.`, { task: row });
      }),
  );

  server.registerTool(
    "move_tasks",
    {
      title: "Move tasks",
      description: "Moves tasks or sections (with everything under them) to another place on the board: into a section or under a task, after a given row, in the order given.",
      inputSchema: z.object({
        project: z.string().min(1),
        tasks: z.array(z.string().min(1)).min(1).max(MAX_TASKS_PER_CALL).describe("ids or titles of the rows to move"),
        parent: z.string().nullable().optional().describe("the section or task to move them into (id or title); null for the top level; default: where `after` is"),
        after: z.string().nullable().optional().describe("the row to put them after; null for first; default: at the end"),
      }),
    },
    ({ project: ref, tasks, parent, after }) =>
      guarded(async () => {
        const edit = await editProject(tools, ref);
        const moving = tasks.map((taskRef) => edit.find(taskRef));
        const afterRow = after ? edit.find(after) : null;
        const parentId = parent === undefined ? (afterRow ? (edit.row(afterRow.id)?.row.parentId ?? null) : null) : parent === null ? null : edit.find(parent).id;
        await edit.steps(async () => {
          let previous: string | null =
            after === null ? null : (afterRow?.id ?? edit.rows.filter((entry) => entry.row.parentId === parentId && !moving.some((row) => row.id === entry.row.id)).at(-1)?.row.id ?? null);
          for (const row of moving) {
            await edit.run({ type: "moveRow", id: row.id, parentId, afterId: previous });
            previous = row.id;
            await edit.load();
          }
        });
        return answer(`Moved ${moving.length} ${moving.length === 1 ? "row" : "rows"}.`, { moved: await edit.describe(moving.map((row) => row.id)) });
      }),
  );

  server.registerTool(
    "delete_tasks",
    {
      title: "Delete tasks",
      description: "Deletes tasks or sections, with everything under them. Tasks that followed them lose that link. undo brings them back.",
      inputSchema: z.object({ project: z.string().min(1), tasks: z.array(z.string().min(1)).min(1).max(MAX_TASKS_PER_CALL) }),
      annotations: { destructiveHint: true },
    },
    ({ project: ref, tasks }) =>
      guarded(async () => {
        const edit = await editProject(tools, ref);
        const rows = tasks.map((taskRef) => edit.find(taskRef));
        await edit.steps(() => edit.run({ type: "deleteRows", ids: [...new Set(rows.map((row) => row.id))] }));
        return answer(`Deleted ${rows.map((row) => `“${row.title}”`).join(", ")}.`, { deleted: rows });
      }),
  );

  server.registerTool(
    "undo",
    {
      title: "Undo the last change",
      description:
        "Reverts this app's last call that changed a board (add_tasks, update_task, move_tasks or delete_tasks) as a whole. " +
        "Parts that someone changed since are left as they are. Project names and the team calendar aren't covered.",
      inputSchema: z.object({}),
    },
    () =>
      guarded(async () => {
        const connection = await context.db.mcpConnection.findUnique({ where: { id: caller.connectionId } });
        const last = connection?.lastCall as LastCall | null | undefined;
        if (!last || last.commandIds.length === 0) throw new ToolProblem("There's nothing to undo.");
        const actor = aiActorOf(caller.user, caller.app, caller.connectionId);
        let skipped = 0;
        let reverted = 0;
        const problems: string[] = [];
        for (const target of [...last.commandIds].reverse()) {
          try {
            skipped += (await context.projects.undoCommand(last.projectId, actor, randomUUID(), target)).skipped;
            reverted++;
          } catch (error) {
            if (!(error instanceof HttpError)) throw error;
            problems.push(error.message);
          }
        }
        await context.db.mcpConnection.update({ where: { id: caller.connectionId }, data: { lastCall: { projectId: last.projectId, commandIds: [] } } });
        const project = await context.db.project.findUnique({ where: { id: last.projectId } });
        return answer(
          `Undid the last change to “${project?.name ?? "the project"}”${skipped || problems.length ? " — parts changed since by someone else were left as they are" : ""}.`,
          { reverted, skipped: skipped + problems.length },
        );
      }),
  );
};

function spanStart(edit: BoardEdit, id: string): string | null {
  const span = edit.row(id)?.span;
  return span ? fromDay(span.start) : null;
}

/** Applies the optional task fields, in an order the engine accepts (dates before links, links before lag). */
async function applyTaskFields(
  edit: BoardEdit,
  id: string,
  fields: {
    description?: string | undefined;
    color?: (typeof TASK_COLORS)[number] | undefined;
    start?: string | undefined;
    half?: "morning" | "afternoon" | undefined;
    durationDays?: number | undefined;
    assignee?: string | null | undefined;
    predecessor?: string | null | undefined;
    lagDays?: number | undefined;
    milestone?: boolean | undefined;
  },
  team: Awaited<ReturnType<ToolContext["context"]["instance"]["resources"]>>,
  added: readonly { id: string; title: string }[],
  /** created on its start date already (only an afternoon start is left to set) */
  startAlready: boolean,
): Promise<void> {
  if (fields.milestone !== undefined) await edit.run({ type: "convertMilestone", id, milestone: fields.milestone });
  if (fields.durationDays !== undefined) await edit.run({ type: "setDuration", id, duration: fields.durationDays });
  if (fields.start !== undefined && (!startAlready || fields.half === "afternoon")) {
    await edit.run({ type: "moveTask", id, start: fields.start, ...(fields.half ? { half: fields.half } : {}) });
  }
  if (fields.assignee !== undefined) {
    await edit.run({ type: "setAssignee", id, resourceId: fields.assignee === null ? null : pickPerson(team, fields.assignee).id });
  }
  if (fields.predecessor === null) {
    await edit.run({ type: "removePredecessor", id });
  } else if (fields.predecessor !== undefined) {
    const predecessor = edit.find(fields.predecessor, "task", added);
    await edit.load();
    // The engine links two tasks with the earlier-starting one first. Here the direction is the AI's:
    // a follower that isn't scheduled yet, or starts first, is placed where its predecessor starts,
    // and the link then places it after.
    const before = edit.row(predecessor.id)?.span;
    const follower = edit.row(id)?.span;
    if (before && (!follower || spanStartHalf(follower) < spanStartHalf(before))) {
      await edit.run({ type: "moveTask", id, start: fromDay(before.start), ...(before.startsAfternoon ? { half: "afternoon" as const } : {}) });
    }
    await edit.run({ type: "linkTasks", fromId: predecessor.id, toId: id });
  }
  if (fields.lagDays !== undefined) await edit.run({ type: "setOffset", id, offset: fields.lagDays });
  if (fields.description !== undefined) await edit.run({ type: "setDescription", id, description: fields.description });
  if (fields.color !== undefined) await edit.run({ type: "setColor", id, color: fields.color });
}
