import { ProjectCommandBody, toEngineCommand, UndoBody } from "@ganttlines/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireProjectAccess } from "../auth/request-access";
import { badRequest } from "../errors";
import { parseBody, parseId } from "../validation";
import type { RouteContext } from "./context";

const Since = z.coerce.number().int().min(0);

/** Row commands, undo/redo (editors) and catch-up of applied changes (viewers). */
export function commandRoutes(app: FastifyInstance, context: RouteContext): void {
  const { projects } = context;
  app.post<{ Params: { id: string } }>("/api/projects/:id/commands", async (request) => {
    const projectId = parseId(request.params.id, "Project");
    const { actor } = await requireProjectAccess(request, context, projectId, "edit");
    const body = parseBody(ProjectCommandBody, request.body);
    return projects.apply(projectId, actor, body.commandId, toEngineCommand(body.command));
  });

  for (const direction of ["undo", "redo"] as const) {
    app.post<{ Params: { id: string } }>(`/api/projects/:id/${direction}`, async (request) => {
      const projectId = parseId(request.params.id, "Project");
      const { actor } = await requireProjectAccess(request, context, projectId, "edit");
      const { commandId } = parseBody(UndoBody, request.body);
      return projects[direction](projectId, actor, commandId);
    });
  }

  app.get<{ Params: { id: string }; Querystring: { since?: string } }>("/api/projects/:id/changes", async (request) => {
    const projectId = parseId(request.params.id, "Project");
    await requireProjectAccess(request, context, projectId, "view");
    const since = Since.safeParse(request.query.since ?? "");
    if (!since.success) throw badRequest("`since` must be a version number");
    return projects.changesSince(projectId, since.data);
  });
}
