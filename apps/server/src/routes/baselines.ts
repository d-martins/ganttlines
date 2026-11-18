import type { Baseline, Db } from "@ganttlines/db";
import { CreateBaselineBody, type BaselineDto, type BaselineTaskDto } from "@ganttlines/protocol";
import type { FastifyInstance } from "fastify";
import { actorOf } from "../actor";
import { requireUser } from "../auth/guard";
import { requireProjectAccess } from "../auth/request-access";
import { conflict, notFound } from "../errors";
import { parseBody, parseId } from "../validation";
import { assertNotArchived } from "./board-helpers";
import type { RouteContext } from "./context";

export const MAX_BASELINES_PER_PROJECT = 100;

/** A project's baselines, newest first (lists never load the possibly large snapshots). */
export async function listBaselines(db: Db, projectId: string): Promise<BaselineDto[]> {
  return (await db.baseline.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, select: BASELINE_SUMMARY })).map(toBaselineDto);
}

/** Change + re-read + broadcast one at a time per project, so the last list sent is the latest. */
function changeBaselines<T>({ boardQueue, live }: RouteContext, projectId: string, work: () => Promise<T>): Promise<T> {
  return boardQueue.run(`baselines:${projectId}`, async () => {
    const result = await work();
    await live.baselines(projectId);
    return result;
  });
}

/** Saves the project's scheduled dates as a baseline, credited to `actor` (the web app and AI apps alike). */
export async function saveBaseline(context: RouteContext, projectId: string, name: string, actor: { userId: string | null; label: string }): Promise<BaselineDto> {
  const { db, projects } = context;
  const baseline = await changeBaselines(context, projectId, async () => {
    const tasks = await projects.scheduleSnapshot(projectId);
    await assertNotArchived(db, projectId);
    if ((await db.baseline.count({ where: { projectId } })) >= MAX_BASELINES_PER_PROJECT) {
      throw conflict(`At most ${MAX_BASELINES_PER_PROJECT} baselines per project`);
    }
    return db.baseline.create({
      data: { projectId, name, createdByUserId: actor.userId, createdByLabel: actor.label, snapshot: tasks as unknown as object[] },
      select: BASELINE_SUMMARY,
    });
  });
  return toBaselineDto(baseline);
}

export async function deleteBaseline(context: RouteContext, baseline: Pick<Baseline, "id" | "projectId">): Promise<void> {
  await changeBaselines(context, baseline.projectId, () => context.db.baseline.deleteMany({ where: { id: baseline.id } }));
}

/** A baseline as the web app reads it: its summary and its saved tasks. */
export const readBaseline = (baseline: Baseline) => ({ baseline: toBaselineDto(baseline), tasks: baseline.snapshot as unknown as BaselineTaskDto[] });

/**
 * Baselines: saved copies of a project's scheduled dates. Everyone who can see the board can view
 * them (to switch to or overlay); only signed-in editors create or delete them (never via links).
 */
export function baselineRoutes(app: FastifyInstance, context: RouteContext): void {
  const { db } = context;
  const list = (projectId: string) => listBaselines(db, projectId);

  app.get<{ Params: { id: string } }>("/api/projects/:id/baselines", async (request) => {
    const projectId = parseId(request.params.id, "Project");
    await requireProjectAccess(request, context, projectId, "view");
    return { baselines: await list(projectId) };
  });

  app.get<{ Params: { id: string } }>("/api/baselines/:id", async (request) => {
    const baseline = await find(request.params.id);
    await requireProjectAccess(request, context, baseline.projectId, "view");
    return readBaseline(baseline);
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/baselines", async (request, reply) => {
    const user = requireUser(request, "editor");
    const projectId = parseId(request.params.id, "Project");
    const { name } = parseBody(CreateBaselineBody, request.body);
    return reply.status(201).send({ baseline: await saveBaseline(context, projectId, name, actorOf(user)) });
  });

  app.delete<{ Params: { id: string } }>("/api/baselines/:id", async (request, reply) => {
    requireUser(request, "editor");
    const baseline = await find(request.params.id);
    await deleteBaseline(context, baseline);
    return reply.status(204).send();
  });

  async function find(rawId: string): Promise<Baseline> {
    const baseline = await db.baseline.findUnique({ where: { id: parseId(rawId, "Baseline") } });
    if (!baseline) throw notFound("Baseline");
    return baseline;
  }
}

const BASELINE_SUMMARY = { id: true, name: true, createdAt: true, createdByLabel: true } as const;

function toBaselineDto(baseline: Pick<Baseline, "id" | "name" | "createdAt" | "createdByLabel">): BaselineDto {
  return { id: baseline.id, name: baseline.name, createdAt: baseline.createdAt.toISOString(), createdBy: baseline.createdByLabel };
}
