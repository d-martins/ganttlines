import { SetupBody } from "@ganttlines/protocol";
import type { FastifyInstance } from "fastify";
import { toUserDto } from "../dto";
import { conflict, HttpError } from "../errors";
import { parseBody } from "../validation";
import { setSessionCookie, type RouteContext } from "./context";

/**
 * First run without ADMIN_* settings: the admin account is created in the browser, with the setup
 * code the server printed in its log.
 */
export function setupRoutes(app: FastifyInstance, { config, sessions, firstRun, loginLimiter }: RouteContext): void {
  app.get("/api/setup", async () => ({ needsSetup: await firstRun.needsSetup() }));

  app.post("/api/setup", async (request, reply) => {
    const body = parseBody(SetupBody, request.body);
    // Cheap early exit so post-setup calls never pay for a password hash (re-checked under the lock).
    if (!(await firstRun.needsSetup())) throw conflict("Setup has already been completed");
    const keys = [`setup:${request.ip}`];
    if (!(await loginLimiter.attempt(keys))) throw new HttpError(429, "too_many_attempts", "Too many failed attempts, try again in a few minutes");
    if (!(await firstRun.checkCode(body.setupCode))) {
      throw new HttpError(403, "wrong_setup_code", "That setup code isn't right — copy it from the server's log");
    }
    const user = await firstRun.createAdmin(body);
    const session = await sessions.create(user.id);
    setSessionCookie(reply, config, session.token, session.expiresAt);
    return reply.status(201).send({ user: toUserDto(user) });
  });
}
