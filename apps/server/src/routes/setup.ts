import { SetupBody } from "@ganttlines/protocol";
import type { FastifyInstance } from "fastify";
import { actorOf } from "../actor";
import { insertResource } from "../calendar/instance-service";
import { hashPassword } from "../auth/passwords";
import { toUserDto } from "../dto";
import { conflict } from "../errors";
import { parseBody } from "../validation";
import { setSessionCookie, type RouteContext } from "./context";

/** First run: the first person to open the app creates the admin account. */
export function setupRoutes(app: FastifyInstance, { db, config, sessions, instance }: RouteContext): void {
  app.get("/api/setup", async () => ({ needsSetup: (await db.user.count()) === 0 }));

  app.post("/api/setup", async (request, reply) => {
    const body = parseBody(SetupBody, request.body);
    // Cheap early exit so post-setup calls never pay for a password hash (re-checked under the lock below).
    if ((await db.user.count()) > 0) throw conflict("Setup has already been completed");
    const passwordHash = await hashPassword(body.password);
    // The admin and their team member are created together (one instance mutation).
    const user = await instance.mutate(actorOf, "setup", { email: body.email }, async (tx) => {
      // Serialise concurrent setup attempts; only the first may create the admin.
      await tx.$executeRaw`LOCK TABLE "User" IN EXCLUSIVE MODE`;
      if ((await tx.user.count()) > 0) throw conflict("Setup has already been completed");
      const created = await tx.user.create({ data: { email: body.email, name: body.name, passwordHash, role: "admin" } });
      await insertResource(tx, { name: created.name, userId: created.id });
      return created;
    });
    const session = await sessions.create(user.id);
    setSessionCookie(reply, config, session.token, session.expiresAt);
    return reply.status(201).send({ user: toUserDto(user) });
  });
}
