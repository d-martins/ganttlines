import { UpdateCheckBody, type AboutDto } from "@ganttlines/protocol";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth/guard";
import { isNewer, type UpdateChecker } from "../updates";
import { parseBody } from "../validation";
import type { RouteContext } from "./context";

/** The running version for everyone signed in; admins also see (and switch) the update check. */
export function aboutRoutes(app: FastifyInstance, { db, config }: RouteContext, updates: UpdateChecker): void {
  app.get("/api/about", async (request): Promise<AboutDto> => {
    const user = requireUser(request);
    if (user.role !== "admin") return { version: config.version };
    const settings = await db.settings.findUnique({ where: { id: 1 } });
    const enabled = settings?.updateCheck ?? true;
    const latest = enabled ? await updates.latest() : null;
    return { version: config.version, updates: { enabled, latest, available: latest !== null && isNewer(latest.version, config.version) } };
  });

  app.put("/api/settings/update-check", async (request) => {
    requireUser(request, "admin");
    const { enabled } = parseBody(UpdateCheckBody, request.body);
    await db.settings.upsert({ where: { id: 1 }, create: { id: 1, updateCheck: enabled }, update: { updateCheck: enabled } });
    return { enabled };
  });
}
