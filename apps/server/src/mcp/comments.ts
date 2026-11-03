import { z } from "zod";
import { aiActorOf } from "../actor";
import { postComment } from "../routes/comments";
import { pickOne, pickProject } from "./lookup";
import { answer, guarded, type ToolGroup } from "./tools";

/** Reading and adding comments on tasks and sections. */
export const comments: ToolGroup = (server, tools) => {
  const { context, caller } = tools;

  /** The project, and the task or section (by id or title) when one is named. */
  async function rowOf(projectRef: string, rowRef: string | undefined, includeArchived: boolean) {
    const project = pickProject(await context.db.project.findMany({ where: includeArchived ? {} : { archivedAt: null } }), projectRef);
    const { rows } = await context.projects.outline(project.id);
    const commentable = rows.map((entry) => ({ id: entry.row.id, title: entry.row.title }));
    const row = rowRef ? pickOne(commentable, rowRef, (candidate) => candidate.id, (candidate) => candidate.title, "task or section") : null;
    return { project, row, titles: new Map(commentable.map((candidate) => [candidate.id, candidate.title])) };
  }

  server.registerTool(
    "list_comments",
    {
      title: "Read comments",
      description: "Reads the latest comments on a project's tasks and sections (or on one of them), newest first. Comments are Markdown.",
      inputSchema: z.object({
        project: z.string().min(1).describe("the project's id or name"),
        task: z.string().optional().describe("only this task or section (id or title)"),
        limit: z.number().int().min(1).max(100).optional().describe("default 30"),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ project: projectRef, task: rowRef, limit = 30 }) =>
      guarded(async () => {
        const { project, row, titles } = await rowOf(projectRef, rowRef, true);
        const found = await context.db.comment.findMany({
          where: { projectId: project.id, deletedAt: null, ...(row ? { taskId: row.id } : {}) },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit,
        });
        const list = found.map((comment) => ({
          id: comment.id,
          task: titles.get(comment.taskId) ?? "(deleted)",
          by: comment.authorLabel,
          at: comment.createdAt.toISOString(),
          text: comment.body,
        }));
        return answer(`${list.length} ${list.length === 1 ? "comment" : "comments"}${row ? ` on “${row.title}”` : ` in “${project.name}”`}.`, { comments: list });
      }),
  );

  server.registerTool(
    "add_comment",
    {
      title: "Comment on a task or section",
      description: "Adds a comment to a task or section, as the person who connected this app (shown “via” the app). Markdown works.",
      inputSchema: z.object({
        project: z.string().min(1),
        task: z.string().min(1).describe("the task's or section's id or title"),
        text: z.string().min(1).max(10_000),
      }),
    },
    ({ project: projectRef, task: rowRef, text }) =>
      guarded(async () => {
        const { project, row } = await rowOf(projectRef, rowRef, false);
        const comment = await postComment(context, project.id, aiActorOf(caller.user, caller.app, caller.connectionId), row!.id, text.trim());
        return answer(`Commented on “${row!.title}”.`, { comment: { id: comment.id, task: row!.title, by: comment.authorLabel, at: comment.createdAt.toISOString() } });
      }),
  );
};
