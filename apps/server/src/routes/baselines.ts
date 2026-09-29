import type { Baseline } from "@ganttlines/db";
import { CreateBaselineBody, type BaselineDto, type BaselineTaskDto } from "@ganttlines/protocol";
import type { FastifyInstance } from "fastify";
import { actorOf } from "../actor";
import { requireUser } from "../auth/guard";
import { requireProjectAccess } from "../auth/request-access";
import { conflict, notFound } from "../errors";
import { parseBody, parseId } from "../validation";
import type { RouteContext } from "./context";

export const MAX_BASELINES_PER_PROJECT = 100;

/**
 * Baselines: saved copies of a project's scheduled dates. Everyone who can see the board can view
 * them (to switch to or overlay); only signed-in editors create or delete them (never via links).
 */
export function baselineRoutes(app: FastifyInstance, context: RouteContext): void {
  const { db, projects, hub } = context;

  const list = async (projectId: string) =>
    (await db.baseline.findMany({ where: { projectId }, orderBy: { createdAt: "desc" } })).map(toBaselineDto);
  const announce = async (projectId: string) => hub.broadcast(projectId, { type: "baselines", projectId, baselines: await list(projectId) });

  app.get<{ Params: { id: string } }>("/api/projects/:id/baselines", async (request) => {
    const projectId = parseId(request.params.id, "Project");
    await requireProjectAccess(request, context, projectId, "view");
    return { baselines: await list(projectId) };
  });

  app.get<{ Params: { id: string } }>("/api/baselines/:id", async (request) => {
    const baseline = await find(request.params.id);
    await requireProjectAccess(request, context, baseline.projectId, "view");
    return { baseline: toBaselineDto(baseline), tasks: baseline.snapshot as unknown as BaselineTaskDto[] };
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/baselines", async (request, reply) => {
    const user = requireUser(request, "editor");
    const projectId = parseId(request.params.id, "Project");
    const { name } = parseBody(CreateBaselineBody, request.body);
    const tasks = await projects.scheduleSnapshot(projectId);
    if ((await db.baseline.count({ where: { projectId } })) >= MAX_BASELINES_PER_PROJECT) {
      throw conflict(`At most ${MAX_BASELINES_PER_PROJECT} baselines per project`);
    }
    const actor = actorOf(user);
    const baseline = await db.baseline.create({
      data: { projectId, name, createdByUserId: actor.userId, createdByLabel: actor.label, snapshot: tasks as unknown as object[] },
    });
    await announce(projectId);
    return reply.status(201).send({ baseline: toBaselineDto(baseline) });
  });

  app.delete<{ Params: { id: string } }>("/api/baselines/:id", async (request, reply) => {
    requireUser(request, "editor");
    const baseline = await find(request.params.id);
    await db.baseline.delete({ where: { id: baseline.id } });
    await announce(baseline.projectId);
    return reply.status(204).send();
  });

  async function find(rawId: string): Promise<Baseline> {
    const baseline = await db.baseline.findUnique({ where: { id: parseId(rawId, "Baseline") } });
    if (!baseline) throw notFound("Baseline");
    return baseline;
  }
}

function toBaselineDto(baseline: Baseline): BaselineDto {
  return { id: baseline.id, name: baseline.name, createdAt: baseline.createdAt.toISOString(), createdBy: baseline.createdByLabel };
}
