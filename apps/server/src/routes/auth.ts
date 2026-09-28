import { ChangePasswordBody, LoginBody } from "@ganttlines/protocol";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth/guard";
import { randomBytes } from "node:crypto";
import { hashPassword, verifyPassword } from "../auth/passwords";
import { toUserDto } from "../dto";
import { HttpError } from "../errors";
import { parseBody } from "../validation";
import { clearSessionCookie, setSessionCookie, type RouteContext } from "./context";

const invalidCredentials = () => new HttpError(401, "invalid_credentials", "Wrong email or password");

export function authRoutes(app: FastifyInstance, { db, config, sessions, loginLimiter, hub }: RouteContext): void {
  // Unknown emails are checked against this hash so they take as long as real accounts (no account probing).
  const dummyHash = hashPassword(randomBytes(16).toString("hex"));

  app.post("/api/auth/login", async (request, reply) => {
    const body = parseBody(LoginBody, request.body);
    const keys = [`ip:${request.ip}`, `email:${body.email}`];
    if (loginLimiter.isBlocked(keys)) {
      throw new HttpError(429, "too_many_attempts", "Too many failed attempts, try again in a few minutes");
    }
    const user = await db.user.findUnique({ where: { email: body.email } });
    const passwordOk = await verifyPassword(user?.passwordHash ?? (await dummyHash), body.password);
    if (!user || !passwordOk) {
      loginLimiter.recordFailure(keys);
      throw invalidCredentials();
    }
    loginLimiter.reset(keys);
    const session = await sessions.create(user.id);
    setSessionCookie(reply, config, session.token, session.expiresAt);
    return { user: toUserDto(user) };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    if (request.sessionToken) {
      await sessions.revoke(request.sessionToken);
      hub.closeSession(request.sessionToken);
    }
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
    const keys = [`user:${user.id}`];
    if (loginLimiter.isBlocked(keys)) {
      throw new HttpError(429, "too_many_attempts", "Too many failed attempts, try again in a few minutes");
    }
    if (!(await verifyPassword(user.passwordHash, body.currentPassword))) {
      loginLimiter.recordFailure(keys);
      throw invalidCredentials();
    }
    loginLimiter.reset(keys);
    await db.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(body.newPassword), mustChangePassword: false },
    });
    await sessions.revokeAllForUser(user.id, request.sessionToken ?? undefined);
    hub.closeUser(user.id, request.sessionToken);
    return reply.status(204).send();
  });
}
