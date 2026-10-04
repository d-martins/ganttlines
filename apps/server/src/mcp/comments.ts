import { z } from "zod";
import { aiActorOf } from "../actor";
import { postComment } from "../routes/comments";
import { pickOne, pickProject } from "./lookup";
import { answer, guarded, type ToolGroup } from "./tools";

/** Reading and adding comments on tasks. */
export const comments: ToolGroup = (server, tools) => {
  const { context, caller } = tools;

  async function taskOf(projectRef: string, taskRef: string | undefined, includeArchived: boolean) {
    const project = pickProject(await context.db.project.findMany({ where: includeArchived ? {} : { archivedAt: null } }), projectRef);
    const { rows } = await context.projects.outline(project.id);
    const tasks = rows.filter((entry) => entry.row.kind === "task").map((entry) => ({ id: entry.row.id, title: entry.row.title }));
    const task = taskRef ? pickOne(tasks, taskRef, (row) => row.id, (row) => row.title, "task") : null;
    return { project, task, titles: new Map(tasks.map((row) => [row.id, row.title])) };
  }

  server.registerTool(
    "list_comments",
    {
      title: "Read comments",
      description: "Reads the latest comments on a project's tasks (or on one task), newest first. Comments are Markdown.",
      inputSchema: z.object({
        project: z.string().min(1).describe("the project's id or name"),
        task: z.string().optional().describe("only this task (id or title)"),
        limit: z.number().int().min(1).max(100).optional().describe("default 30"),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ project: projectRef, task: taskRef, limit = 30 }) =>
      guarded(async () => {
        const { project, task, titles } = await taskOf(projectRef, taskRef, true);
        const found = await context.db.comment.findMany({
          where: { projectId: project.id, deletedAt: null, ...(task ? { taskId: task.id } : {}) },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit,
        });
        const list = found.map((comment) => ({
          id: comment.id,
          task: titles.get(comment.taskId) ?? "(deleted task)",
          by: comment.authorLabel,
          at: comment.createdAt.toISOString(),
          text: comment.body,
        }));
        return answer(`${list.length} ${list.length === 1 ? "comment" : "comments"}${task ? ` on “${task.title}”` : ` in “${project.name}”`}.`, { comments: list });
      }),
  );

  server.registerTool(
    "add_comment",
    {
      title: "Comment on a task",
      description: "Adds a comment to a task, as the person who connected this app (shown “via” the app). Markdown works.",
      inputSchema: z.object({
        project: z.string().min(1),
        task: z.string().min(1).describe("the task's id or title"),
        text: z.string().min(1).max(10_000),
      }),
    },
    ({ project: projectRef, task: taskRef, text }) =>
      guarded(async () => {
        const { project, task } = await taskOf(projectRef, taskRef, false);
        const comment = await postComment(context, project.id, aiActorOf(caller.user, caller.app, caller.connectionId), task!.id, text.trim());
        return answer(`Commented on “${task!.title}”.`, { comment: { id: comment.id, task: task!.title, by: comment.authorLabel, at: comment.createdAt.toISOString() } });
      }),
  );
};
