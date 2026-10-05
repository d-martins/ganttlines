import { ChangePasswordBody, ForgotPasswordBody, LoginBody, ResetPasswordBody } from "@ganttlines/protocol";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth/guard";
import { randomBytes } from "node:crypto";
import { hashPassword, verifyPassword } from "../auth/passwords";
import { toUserDto } from "../dto";
import { passwordReset } from "../mail/messages";
import { HttpError } from "../errors";
import { parseBody } from "../validation";
import { clearSessionCookie, setSessionCookie, type RouteContext } from "./context";

const invalidCredentials = () => new HttpError(401, "invalid_credentials", "Wrong email or password");

export function authRoutes(
  app: FastifyInstance,
  { db, config, sessions, loginLimiter, live, mailer, passwordTokens, twoFactor, twoFactorPolicy }: RouteContext,
): void {
  // Unknown emails are checked against this hash so they take as long as real accounts (no account probing).
  const dummyHash = hashPassword(randomBytes(16).toString("hex"));

  app.post("/api/auth/login", async (request, reply) => {
    const body = parseBody(LoginBody, request.body);
    const user = await db.user.findUnique({ where: { email: body.email } });
    // An account's own count (kept however busy the limiter gets); typed-in emails without one count apart.
    const keys = [`ip:${request.ip}`, user ? `user:${user.id}` : `email:${body.email}`];
    if (!(await loginLimiter.attempt(keys))) {
      throw new HttpError(429, "too_many_attempts", "Too many failed attempts, try again in a few minutes");
    }
    const passwordOk = await verifyPassword(user?.passwordHash ?? (await dummyHash), body.password);
    if (!user || !passwordOk) throw invalidCredentials();
    // The account's count starts afresh; the address only gets this attempt back (signing in to one
    // account mustn't clear what the address tried against others).
    await loginLimiter.reset([keys[1]!]);
    await loginLimiter.refund([keys[0]!]);
    // Two-factor: no session yet — the code comes next, with this proof that the password was right.
    if (user.totpEnabled) return { twoFactor: { challenge: twoFactor.challenge(user.id) } };
    const session = await sessions.create(user.id);
    setSessionCookie(reply, config, session.token, session.expiresAt);
    return { user: toUserDto(user, await twoFactorPolicy.mustSetUp(user, false)) };
  });

  /**
   * "Forgot your password?": emails a one-time link when the address has an account. The answer is
   * the same either way (and so is the timing, roughly), so nobody can probe which emails exist.
   */
  app.post("/api/auth/forgot", async (request, reply) => {
    const { email } = parseBody(ForgotPasswordBody, request.body);
    const keys = [`forgot-ip:${request.ip}`, `forgot:${email}`];
    if (!mailer) throw new HttpError(503, "mail_not_configured", "Email isn't set up on this server — ask an admin to reset your password");
    // every request counts: it sends an email
    if (!(await loginLimiter.attempt(keys))) throw new HttpError(429, "too_many_attempts", "Too many requests, try again in a few minutes");
    const user = await db.user.findUnique({ where: { email } });
    if (user) {
      const link = new URL(`/reset-password?token=${await passwordTokens.issue(user.id, "reset")}`, config.publicUrl).toString();
      mailer.send(passwordReset(user.email, user.name, link)).catch((error: unknown) => request.log.error(error, "couldn't send a password reset email"));
    }
    return reply.status(204).send();
  });

  /** Choosing a password from an emailed link: signs in (after the two-factor step, if on), and out everywhere else. */
  app.post("/api/auth/reset", async (request, reply) => {
    const { token, password } = parseBody(ResetPasswordBody, request.body);
    const userId = await passwordTokens.redeem(token);
    if (!userId) throw new HttpError(400, "invalid_token", "This link has expired or was already used — ask for a new one");
    const user = await db.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(password), mustChangePassword: false } });
    await sessions.revokeAllForUser(user.id);
    live.closeUser(user.id);
    // An emailed link alone doesn't get past two-factor: the code step still follows.
    if (user.totpEnabled) return { twoFactor: { challenge: twoFactor.challenge(user.id) } };
    const session = await sessions.create(user.id);
    setSessionCookie(reply, config, session.token, session.expiresAt);
    return { user: toUserDto(user, await twoFactorPolicy.mustSetUp(user, false)) };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    if (request.sessionToken) {
      await sessions.revoke(request.sessionToken);
      live.closeSession(request.sessionToken);
    }
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  app.get("/api/auth/me", async (request) => {
    const user = requireUser(request, "guest", { allowPendingPasswordChange: true, allowTwoFactorSetup: true });
    return { user: toUserDto(user, request.pendingStep === "set_up_two_factor") };
  });

  /** Changing the password clears "must change password" and signs out every other session. */
  app.post("/api/auth/password", async (request, reply) => {
    const user = requireUser(request, "guest", { allowPendingPasswordChange: true, allowTwoFactorSetup: true });
    const body = parseBody(ChangePasswordBody, request.body);
    const keys = [`user:${user.id}`];
    if (!(await loginLimiter.attempt(keys))) {
      throw new HttpError(429, "too_many_attempts", "Too many failed attempts, try again in a few minutes");
    }
    if (!(await verifyPassword(user.passwordHash, body.currentPassword))) throw invalidCredentials();
    await loginLimiter.reset(keys);
    await db.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(body.newPassword), mustChangePassword: false },
    });
    await sessions.revokeAllForUser(user.id, request.sessionToken ?? undefined);
    live.closeUser(user.id, request.sessionToken);
    return reply.status(204).send();
  });
}
