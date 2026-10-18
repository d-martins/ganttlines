import { isLinkChange, type Change } from "@ganttlines/engine";
import { BOARD_LIMITS, type ActivityDto } from "@ganttlines/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireProjectAccess } from "../auth/request-access";
import { badRequest } from "../errors";
import { parseId } from "../validation";
import type { RouteContext } from "./context";

const ActivityQuery = z.object({
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(BOARD_LIMITS.activityPageMax).default(50),
  rowId: z.uuid().optional(),
});

/** The project's history (newest first), optionally only the changes that touched one row or its links. */
export function activityRoutes(app: FastifyInstance, context: RouteContext): void {
  const { db } = context;

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>("/api/projects/:id/activity", async (request): Promise<ActivityDto> => {
    const projectId = parseId(request.params.id, "Project");
    await requireProjectAccess(request, context, projectId, "view");
    const query = ActivityQuery.safeParse(request.query);
    if (!query.success) throw badRequest(z.prettifyError(query.error));
    const { before, limit, rowId } = query.data;
    const rows = await db.commandLog.findMany({
      where: {
        projectId,
        ...(before === undefined ? {} : { version: { lt: before } }),
        ...(rowId === undefined
          ? {}
          : {
              OR: [
                { changes: { array_contains: [{ rowId }] } },
                { changes: { array_contains: [{ link: { followerId: rowId } }] } },
                { changes: { array_contains: [{ link: { predecessorId: rowId } }] } },
              ],
            }),
      },
      orderBy: { version: "desc" },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      entries: page.map((entry) => {
        const changes = entry.changes as unknown as Change[];
        return {
          version: entry.version,
          commandId: entry.commandId,
          name: entry.name,
          actor: { userId: entry.actorUserId, label: entry.actorLabel, linkId: entry.actorLinkId },
          createdAt: entry.createdAt.toISOString(),
          rowIds: [...new Set(changes.flatMap((change) => (isLinkChange(change) ? [change.link.predecessorId, change.link.followerId] : [change.rowId])))],
          changes: rowId === undefined ? changes : changes.filter((change) => touches(change, rowId)),
        };
      }),
      nextBefore: rows.length > limit ? page[page.length - 1]!.version : null,
    };
  });
}

function touches(change: Change, rowId: string): boolean {
  return isLinkChange(change) ? change.link.predecessorId === rowId || change.link.followerId === rowId : change.rowId === rowId;
}
