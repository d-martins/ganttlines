import type { Comment } from "@ganttlines/db";
import { BOARD_LIMITS, CommentBody, EditCommentBody, type CommentDto } from "@ganttlines/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorKey, type Actor } from "../actor";
import { requireProjectAccess } from "../auth/request-access";
import { badRequest, conflict, forbidden, notFound } from "../errors";
import { parseBody, parseId } from "../validation";
import { assertNotArchived } from "./board-helpers";
import type { RouteContext } from "./context";

const CommentsQuery = z.object({
  taskId: z.uuid().optional(),
  /** id of the oldest comment already shown */
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(BOARD_LIMITS.commentPageMax).default(50),
});

/** Comments on tasks: anyone who can see the board reads them; commenters are signed-in users and collaborating link visitors. */
export function commentRoutes(app: FastifyInstance, context: RouteContext): void {
  const { db } = context;

  const announce = (comment: Comment) => context.live.comment(comment);

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>("/api/projects/:id/comments", async (request) => {
    const projectId = parseId(request.params.id, "Project");
    const { actor } = await requireProjectAccess(request, context, projectId, "view");
    const query = CommentsQuery.safeParse(request.query);
    if (!query.success) throw badRequest(z.prettifyError(query.error));
    const { taskId, before, limit } = query.data;
    const cursor = before ? await db.comment.findFirst({ where: { id: before, projectId } }) : null;
    if (before && !cursor) throw notFound("Comment");
    const comments = await db.comment.findMany({
      where: {
        projectId,
        ...(taskId ? { taskId } : {}),
        ...(cursor
          ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const page = comments.slice(0, limit);
    return {
      comments: page.map((comment) => toCommentDto(comment, actorKey(actor))),
      nextBefore: comments.length > limit ? page[page.length - 1]!.id : null,
    };
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/comments", async (request, reply) => {
    const projectId = parseId(request.params.id, "Project");
    const access = await requireProjectAccess(request, context, projectId, "view");
    if (!access.canComment) throw forbidden("You can only view this project");
    const body = parseBody(CommentBody, request.body);
    const comment = await postComment(context, projectId, access.actor, body.taskId, body.body);
    return reply.status(201).send({ comment: toCommentDto(comment, actorKey(access.actor)) });
  });

  app.patch<{ Params: { id: string } }>("/api/comments/:id", async (request) => {
    const comment = await findComment(request.params.id);
    const access = await requireProjectAccess(request, context, comment.projectId, "view");
    if (!isAuthor(comment, access.actor)) throw forbidden("You can only edit your own comments");
    if (!access.canComment) throw forbidden("You can only view this project");
    const { body } = parseBody(EditCommentBody, request.body);
    // Only while not deleted, so an edit racing a delete cannot bring the text back.
    const { count } = await db.comment.updateMany({ where: { id: comment.id, deletedAt: null }, data: { body, editedAt: new Date() } });
    if (count === 0) throw conflict("This comment was deleted");
    const updated = await db.comment.findUniqueOrThrow({ where: { id: comment.id } });
    announce(updated);
    return { comment: toCommentDto(updated, actorKey(access.actor)) };
  });

  app.delete<{ Params: { id: string } }>("/api/comments/:id", async (request, reply) => {
    const comment = await findComment(request.params.id);
    const { actor } = await requireProjectAccess(request, context, comment.projectId, "view");
    const isAdmin = request.user?.role === "admin" && actor.userId === request.user.id;
    if (!isAuthor(comment, actor) && !isAdmin) throw forbidden("You can only delete your own comments");
    const { count } = await db.comment.updateMany({ where: { id: comment.id, deletedAt: null }, data: { body: "", deletedAt: new Date() } });
    if (count > 0) announce(await db.comment.findUniqueOrThrow({ where: { id: comment.id } }));
    return reply.status(204).send();
  });

  async function findComment(rawId: string): Promise<Comment> {
    const comment = await db.comment.findUnique({ where: { id: parseId(rawId, "Comment") } });
    if (!comment) throw notFound("Comment");
    return comment;
  }
}

/** Adds a comment to a task (of a live project) and shows it to everyone with the board open. */
export async function postComment(context: RouteContext, projectId: string, actor: Actor, taskId: string, body: string): Promise<Comment> {
  await assertNotArchived(context.db, projectId);
  if (!(await context.projects.hasTask(projectId, taskId))) throw notFound("Task");
  if ((await context.db.comment.count({ where: { projectId, taskId, deletedAt: null } })) >= BOARD_LIMITS.commentsPerTask) {
    throw conflict(`A task can have at most ${BOARD_LIMITS.commentsPerTask} comments — delete some first`);
  }
  const comment = await context.db.comment.create({
    data: { projectId, taskId, authorUserId: actor.userId, authorVisitorId: actor.visitorId ?? null, authorLabel: actor.label, body },
  });
  context.live.comment(comment);
  return comment;
}

function authorKeyOf(comment: Comment): string | null {
  if (comment.authorUserId) return `user:${comment.authorUserId}`;
  if (comment.authorVisitorId) return `visitor:${comment.authorVisitorId}`;
  return null;
}

function isAuthor(comment: Comment, actor: Actor): boolean {
  const key = actorKey(actor);
  return key !== null && key === authorKeyOf(comment);
}

/** `viewerKey` identifies the person the DTO is for ("user:<id>" / "visitor:<id>"). */
export function toCommentDto(comment: Comment, viewerKey: string | null): CommentDto {
  const author = authorKeyOf(comment);
  return {
    id: comment.id,
    taskId: comment.taskId,
    author: { userId: comment.authorUserId, label: comment.authorLabel },
    body: comment.deletedAt ? "" : comment.body,
    createdAt: comment.createdAt.toISOString(),
    editedAt: comment.editedAt?.toISOString() ?? null,
    deleted: comment.deletedAt !== null,
    mine: author !== null && author === viewerKey,
  };
}
