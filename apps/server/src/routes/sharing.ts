import type { ShareLink } from "@ganttlines/db";
import { CreateShareLinkBody, UpdateShareLinkBody, VisitorBody, type ShareInfoDto, type ShareLinkDto } from "@ganttlines/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { actorOf } from "../actor";
import { VISITOR_COOKIE } from "../auth/access";
import { requireUser } from "../auth/guard";
import { credentialsOf, throttleShareTokens } from "../auth/request-access";
import { badRequest, HttpError, notFound } from "../errors";
import { parseBody, parseId } from "../validation";
import type { RouteContext } from "./context";

const VISITOR_COOKIE_MAX_AGE_S = 180 * 24 * 60 * 60;

/**
 * Share links. Editors create, list, change and revoke links for a project; anyone
 * with a link can look it up and — for anonymous links — pick a display name.
 */
export function sharingRoutes(app: FastifyInstance, context: RouteContext): void {
  const { db, config, access, hub } = context;

  app.post<{ Params: { id: string } }>("/api/projects/:id/share-links", async (request, reply) => {
    const user = requireUser(request, "editor");
    const projectId = parseId(request.params.id, "Project");
    const body = parseBody(CreateShareLinkBody, request.body);
    if (!(await db.project.findUnique({ where: { id: projectId } }))) throw notFound("Project");
    const { token, tokenHash } = access.newToken();
    const actor = actorOf(user);
    const link = await db.shareLink.create({
      data: { projectId, tokenHash, access: body.access, collaboration: body.collaboration, label: body.label, createdByUserId: actor.userId, createdByLabel: actor.label },
    });
    return reply.status(201).send({ link: toDto(link), token, url: new URL(`/s/${token}`, config.publicUrl).toString() });
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/share-links", async (request) => {
    requireUser(request, "editor");
    const projectId = parseId(request.params.id, "Project");
    const links = await db.shareLink.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
    return { links: links.map(toDto) };
  });

  app.patch<{ Params: { id: string } }>("/api/share-links/:id", async (request) => {
    requireUser(request, "editor");
    const id = parseId(request.params.id, "Share link");
    const body = parseBody(UpdateShareLinkBody, request.body);
    if (!(await db.shareLink.findUnique({ where: { id } }))) throw notFound("Share link");
    const link = await db.shareLink.update({
      where: { id },
      data: { ...(body.collaboration === undefined ? {} : { collaboration: body.collaboration }), ...(body.label === undefined ? {} : { label: body.label }) },
    });
    access.invalidate(id); // connected visitors pick up the new collaboration setting on their next message
    return { link: toDto(link) };
  });

  app.delete<{ Params: { id: string } }>("/api/share-links/:id", async (request, reply) => {
    requireUser(request, "editor");
    const id = parseId(request.params.id, "Share link");
    if (!(await db.shareLink.findUnique({ where: { id } }))) throw notFound("Share link");
    await db.shareLink.update({ where: { id }, data: { revokedAt: new Date() } });
    access.invalidate(id);
    hub.closeLink(id);
    return reply.status(204).send();
  });

  /** Public: what a link opens, and what the visitor still has to do (sign in / pick a name). */
  app.get<{ Params: { token: string } }>("/api/share/:token", async (request): Promise<ShareInfoDto> => {
    const link = await findLink(request, request.params.token);
    const project = await db.project.findUniqueOrThrow({ where: { id: link.projectId } });
    const user = request.user;
    return {
      project: { id: project.id, name: project.name },
      access: link.access,
      collaboration: link.collaboration,
      label: link.label,
      needsSignIn: link.access === "authenticated" && (!user || request.pendingStep !== null),
      visitor: link.access === "anonymous" ? pickName(access.readVisitor(request.cookies[VISITOR_COOKIE])) : null,
    };
  });

  /** Anonymous links: remember the visitor's display name (signed cookie, keeps the same visitor id). */
  app.post<{ Params: { token: string } }>("/api/share/:token/visitor", async (request, reply) => {
    const link = await findLink(request, request.params.token);
    if (link.access !== "anonymous") throw badRequest("This link requires signing in");
    const { name } = parseBody(VisitorBody, request.body);
    const id = access.readVisitor(request.cookies[VISITOR_COOKIE])?.id ?? randomUUID();
    reply.setCookie(VISITOR_COOKIE, access.signVisitor({ id, name }), {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: config.publicUrl.protocol === "https:",
      maxAge: VISITOR_COOKIE_MAX_AGE_S,
    });
    return { visitor: { name } };
  });

  async function findLink(request: FastifyRequest, token: string): Promise<ShareLink> {
    const credentials = { ...credentialsOf(request, access), shareToken: token };
    return throttleShareTokens(request, context, credentials, async () => {
      const link = await access.find(token);
      if (!link) throw notFound("Share link");
      if (link.revokedAt) throw new HttpError(410, "link_revoked", "This share link was turned off");
      return link;
    });
  }
}

function pickName(visitor: { name: string } | null): { name: string } | null {
  return visitor ? { name: visitor.name } : null;
}

function toDto(link: ShareLink): ShareLinkDto {
  return {
    id: link.id,
    projectId: link.projectId,
    access: link.access,
    collaboration: link.collaboration,
    label: link.label,
    createdBy: link.createdByLabel,
    createdAt: link.createdAt.toISOString(),
    revoked: link.revokedAt !== null,
  };
}
