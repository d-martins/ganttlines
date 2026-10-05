import type { Db, Highlight } from "@ganttlines/db";
import { HighlightBody, type HighlightDto } from "@ganttlines/protocol";
import type { FastifyInstance } from "fastify";
import { requireProjectAccess } from "../auth/request-access";
import { conflict, notFound } from "../errors";
import { parseBody, parseId } from "../validation";
import { assertNotArchived } from "./board-helpers";
import type { RouteContext } from "./context";

export const MAX_HIGHLIGHTS_PER_PROJECT = 1_000;

/** A project's highlighted days, in date order. */
export async function listHighlights(db: Db, projectId: string): Promise<HighlightDto[]> {
  return (await db.highlight.findMany({ where: { projectId }, orderBy: [{ date: "asc" }, { id: "asc" }] })).map(toHighlightDto);
}

/** Highlighted days: everyone who can see the board sees them; everyone who can edit it changes them. */
export function highlightRoutes(app: FastifyInstance, context: RouteContext): void {
  const { db, live, boardQueue } = context;

  const list = (projectId: string) => listHighlights(db, projectId);
  const announce = (projectId: string) => live.highlights(projectId);
  /** Change + re-read + broadcast one at a time per project, so the last list sent is the latest. */
  const change = <T>(projectId: string, work: () => Promise<T>) =>
    boardQueue.run(`highlights:${projectId}`, async () => {
      await assertNotArchived(db, projectId);
      const result = await work();
      await announce(projectId);
      return result;
    });

  app.get<{ Params: { id: string } }>("/api/projects/:id/highlights", async (request) => {
    const projectId = parseId(request.params.id, "Project");
    await requireProjectAccess(request, context, projectId, "view");
    return { highlights: await list(projectId) };
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/highlights", async (request, reply) => {
    const projectId = parseId(request.params.id, "Project");
    await requireProjectAccess(request, context, projectId, "edit");
    const body = parseBody(HighlightBody, request.body);
    const highlight = await change(projectId, async () => {
      if ((await db.highlight.count({ where: { projectId } })) >= MAX_HIGHLIGHTS_PER_PROJECT) {
        throw conflict(`At most ${MAX_HIGHLIGHTS_PER_PROJECT} highlights per project`);
      }
      return toHighlightDto(await db.highlight.create({ data: { projectId, ...body } }));
    });
    return reply.status(201).send({ highlight });
  });

  app.put<{ Params: { id: string } }>("/api/highlights/:id", async (request) => {
    const existing = await find(request.params.id);
    await requireProjectAccess(request, context, existing.projectId, "edit");
    const body = parseBody(HighlightBody, request.body);
    const highlight = await change(existing.projectId, async () =>
      toHighlightDto(await db.highlight.update({ where: { id: existing.id }, data: body })),
    );
    return { highlight };
  });

  app.delete<{ Params: { id: string } }>("/api/highlights/:id", async (request, reply) => {
    const existing = await find(request.params.id);
    await requireProjectAccess(request, context, existing.projectId, "edit");
    await change(existing.projectId, () => db.highlight.deleteMany({ where: { id: existing.id } }));
    return reply.status(204).send();
  });

  async function find(rawId: string): Promise<Highlight> {
    const highlight = await db.highlight.findUnique({ where: { id: parseId(rawId, "Highlight") } });
    if (!highlight) throw notFound("Highlight");
    return highlight;
  }
}

function toHighlightDto({ id, date, label, color }: Highlight): HighlightDto {
  return { id, date, label, color };
}
