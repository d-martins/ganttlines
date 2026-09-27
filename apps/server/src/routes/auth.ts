import { ChangePasswordBody, LoginBody } from "@ganttlines/protocol";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth/guard";
import { hashPassword, verifyPassword } from "../auth/passwords";
import { toUserDto } from "../dto";
import { HttpError } from "../errors";
import { parseBody } from "../validation";
import { clearSessionCookie, setSessionCookie, type RouteContext } from "./context";

const invalidCredentials = () => new HttpError(401, "invalid_credentials", "Wrong email or password");

export function authRoutes(app: FastifyInstance, { db, config, sessions, loginLimiter }: RouteContext): void {
  app.post("/api/auth/login", async (request, reply) => {
    const body = parseBody(LoginBody, request.body);
    const keys = [`ip:${request.ip}`, `email:${body.email}`];
    if (loginLimiter.isBlocked(keys)) {
      throw new HttpError(429, "too_many_attempts", "Too many failed attempts, try again in a few minutes");
    }
    const user = await db.user.findUnique({ where: { email: body.email } });
    if (!user || !(await verifyPassword(user.passwordHash, body.password))) {
      loginLimiter.recordFailure(keys);
      throw invalidCredentials();
    }
    loginLimiter.reset(keys);
    const session = await sessions.create(user.id);
    setSessionCookie(reply, config, session.token, session.expiresAt);
    return { user: toUserDto(user) };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    if (request.sessionToken) await sessions.revoke(request.sessionToken);
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  app.get("/api/auth/me", async (request) => {
    return { user: toUserDto(requireUser(request, "guest", { allowPendingPasswordChange: true })) };
  });

  /** Changing the password clears "must change password" and signs out every other session. */
  app.post("/api/auth/password", async (request, reply) => {
    const user = requireUser(request, "guest", { allowPendingPasswordChange: true });
    const body = parseBody(ChangePasswordBody, request.body);
    if (!(await verifyPassword(user.passwordHash, body.currentPassword))) throw invalidCredentials();
    await db.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(body.newPassword), mustChangePassword: false },
    });
    await sessions.revokeAllForUser(user.id, request.sessionToken ?? undefined);
    return reply.status(204).send();
  });
}
