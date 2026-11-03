import { SHARE_TOKEN_HEADER, type TagsDto } from "@ganttlines/protocol";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth/guard";
import { forbidden } from "../errors";
import { workspaceTags } from "../projects/tags";
import type { RouteContext } from "./context";

/** The workspace's tags, for suggestions while tagging: only people who can edit see every project's tags. */
export function tagRoutes(app: FastifyInstance, { db }: RouteContext): void {
  app.get("/api/tags", async (request): Promise<TagsDto> => {
    // A share link opens one board only; other projects' tags aren't for its visitors.
    if (!request.user && request.headers[SHARE_TOKEN_HEADER] !== undefined) throw forbidden();
    requireUser(request, "editor");
    return { tags: await workspaceTags(db) };
  });
}
