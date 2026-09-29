import type { Comment } from "@ganttlines/db";
import { CommentBody, EditCommentBody, type CommentDto } from "@ganttlines/protocol";
import type { FastifyInstance } from "fastify";
import type { Actor } from "../actor";
import { requireProjectAccess } from "../auth/request-access";
import { conflict, forbidden, notFound } from "../errors";
import { parseBody, parseId } from "../validation";
import type { RouteContext } from "./context";

/** Comments on tasks: anyone who can see the board reads them; commenters are signed-in users and collaborating link visitors. */
export function commentRoutes(app: FastifyInstance, context: RouteContext): void {
  const { db, projects, hub } = context;

  app.get<{ Params: { id: string }; Querystring: { taskId?: string } }>("/api/projects/:id/comments", async (request) => {
    const projectId = parseId(request.params.id, "Project");
    await requireProjectAccess(request, context, projectId, "view");
    const taskId = request.query.taskId === undefined ? undefined : parseId(request.query.taskId, "Task");
    const comments = await db.comment.findMany({
      where: { projectId, ...(taskId ? { taskId } : {}) },
      orderBy: { createdAt: "asc" },
      take: 1000,
    });
    return { comments: comments.map(toCommentDto) };
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/comments", async (request, reply) => {
    const projectId = parseId(request.params.id, "Project");
    const access = await requireProjectAccess(request, context, projectId, "view");
    if (!access.canComment) throw forbidden("You can only view this project");
    const body = parseBody(CommentBody, request.body);
    if (!(await projects.hasTask(projectId, body.taskId))) throw notFound("Task");
    const { actor } = access;
    const comment = toCommentDto(
      await db.comment.create({
        data: { projectId, taskId: body.taskId, authorUserId: actor.userId, authorVisitorId: actor.visitorId ?? null, authorLabel: actor.label, body: body.body },
      }),
    );
    hub.broadcast(projectId, { type: "comment", projectId, comment });
    return reply.status(201).send({ comment });
  });

  app.patch<{ Params: { id: string } }>("/api/comments/:id", async (request) => {
    const comment = await findComment(request.params.id);
    const { actor } = await requireProjectAccess(request, context, comment.projectId, "view");
    if (!isAuthor(comment, actor)) throw forbidden("You can only edit your own comments");
    if (comment.deletedAt) throw conflict("This comment was deleted");
    const { body } = parseBody(EditCommentBody, request.body);
    const updated = toCommentDto(await db.comment.update({ where: { id: comment.id }, data: { body, editedAt: new Date() } }));
    hub.broadcast(comment.projectId, { type: "comment", projectId: comment.projectId, comment: updated });
    return { comment: updated };
  });

  app.delete<{ Params: { id: string } }>("/api/comments/:id", async (request, reply) => {
    const comment = await findComment(request.params.id);
    const { actor } = await requireProjectAccess(request, context, comment.projectId, "view");
    const isAdmin = request.user?.role === "admin" && actor.userId === request.user.id;
    if (!isAuthor(comment, actor) && !isAdmin) throw forbidden("You can only delete your own comments");
    if (!comment.deletedAt) {
      const deleted = toCommentDto(await db.comment.update({ where: { id: comment.id }, data: { body: "", deletedAt: new Date() } }));
      hub.broadcast(comment.projectId, { type: "comment", projectId: comment.projectId, comment: deleted });
    }
    return reply.status(204).send();
  });

  async function findComment(rawId: string): Promise<Comment> {
    const comment = await db.comment.findUnique({ where: { id: parseId(rawId, "Comment") } });
    if (!comment) throw notFound("Comment");
    return comment;
  }
}

function isAuthor(comment: Comment, actor: Actor): boolean {
  if (actor.userId) return comment.authorUserId === actor.userId;
  return Boolean(actor.visitorId) && comment.authorVisitorId === actor.visitorId;
}

function toCommentDto(comment: Comment): CommentDto {
  return {
    id: comment.id,
    taskId: comment.taskId,
    author: { userId: comment.authorUserId, label: comment.authorLabel },
    body: comment.deletedAt ? "" : comment.body,
    createdAt: comment.createdAt.toISOString(),
    editedAt: comment.editedAt?.toISOString() ?? null,
    deleted: comment.deletedAt !== null,
  };
}
