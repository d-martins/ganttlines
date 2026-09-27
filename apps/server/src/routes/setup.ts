import { SetupBody } from "@ganttlines/protocol";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../auth/passwords";
import { toUserDto } from "../dto";
import { conflict } from "../errors";
import { createLinkedResource } from "../resources";
import { parseBody } from "../validation";
import { setSessionCookie, type RouteContext } from "./context";

/** First run: the first person to open the app creates the admin account. */
export function setupRoutes(app: FastifyInstance, { db, config, sessions }: RouteContext): void {
  app.get("/api/setup", async () => ({ needsSetup: (await db.user.count()) === 0 }));

  app.post("/api/setup", async (request, reply) => {
    const body = parseBody(SetupBody, request.body);
    const passwordHash = await hashPassword(body.password);
    const user = await db.$transaction(async (tx) => {
      // Serialise concurrent setup attempts; only the first may create the admin.
      await tx.$executeRaw`LOCK TABLE "User" IN EXCLUSIVE MODE`;
      if ((await tx.user.count()) > 0) throw conflict("Setup has already been completed");
      const created = await tx.user.create({ data: { email: body.email, name: body.name, passwordHash, role: "admin" } });
      await createLinkedResource(tx, created.id, created.name);
      return created;
    });
    const session = await sessions.create(user.id);
    setSessionCookie(reply, config, session.token, session.expiresAt);
    return reply.status(201).send({ user: toUserDto(user) });
  });
}
