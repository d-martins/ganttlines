import { CreateProjectBody, UpdateProjectBody } from "@ganttlines/protocol";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth/guard";
import { toProjectDto } from "../dto";
import { notFound } from "../errors";
import { loadProjectState } from "../projects/state";
import { parseBody, parseId } from "../validation";
import type { RouteContext } from "./context";

/** Viewers and above see every project; guests see none (they get access through share links, plan 2c). */
export function projectRoutes(app: FastifyInstance, { db }: RouteContext): void {
  app.get<{ Querystring: { archived?: string } }>("/api/projects", async (request) => {
    const user = requireUser(request, "guest");
    if (user.role === "guest") return { projects: [] };
    const includeArchived = request.query.archived === "true";
    const projects = await db.project.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      orderBy: { createdAt: "asc" },
    });
    return { projects: projects.map(toProjectDto) };
  });

  app.post("/api/projects", async (request, reply) => {
    requireUser(request, "editor");
    const body = parseBody(CreateProjectBody, request.body);
    const project = await db.project.create({ data: { name: body.name } });
    return reply.status(201).send({ project: toProjectDto(project) });
  });

  app.patch<{ Params: { id: string } }>("/api/projects/:id", async (request) => {
    requireUser(request, "editor");
    const id = parseId(request.params.id, "Project");
    const body = parseBody(UpdateProjectBody, request.body);
    if (!(await db.project.findUnique({ where: { id } }))) throw notFound("Project");
    const project = await db.project.update({
      where: { id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.archived === undefined ? {} : { archivedAt: body.archived ? new Date() : null }),
      },
    });
    return { project: toProjectDto(project) };
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/state", async (request) => {
    requireUser(request, "viewer");
    return loadProjectState(db, parseId(request.params.id, "Project"));
  });
}
