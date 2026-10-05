import { DisableTwoFactorBody, EnableTwoFactorBody, TwoFactorLoginBody } from "@ganttlines/protocol";
import type { User } from "@ganttlines/db";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth/guard";
import { verifyPassword } from "../auth/passwords";
import { toUserDto } from "../dto";
import { conflict, HttpError, notFound } from "../errors";
import { parseBody, parseId } from "../validation";
import { setSessionCookie, type RouteContext } from "./context";

const OFF = { totpEnabled: false, totpSecret: null, totpLastStep: null, totpRecovery: [] };
const tooMany = () => new HttpError(429, "too_many_attempts", "Too many failed attempts, try again in a few minutes");

/**
 * Two-factor sign-in for password accounts (admins can require it, see `TwoFactorPolicy`). Turning it on: `/setup` (secret + QR), then `/enable`
 * with the app's first code (returns recovery codes). Signing in: the password step answers with
 * a challenge, and `/api/auth/login/2fa` exchanges it and a code for a session.
 */
export function twoFactorRoutes(app: FastifyInstance, { db, config, sessions, loginLimiter, twoFactor, twoFactorPolicy }: RouteContext): void {
  /** Checks an app code (not reused) or a recovery code (used up); returns the fields to store, or null. */
  function accept(user: User, code: string): Partial<User> | null {
    const secret = user.totpSecret ? twoFactor.decrypt(user.totpSecret) : null;
    const step = secret ? twoFactor.check(secret, code) : null;
    if (step !== null) return step > (user.totpLastStep ?? -1) ? { totpLastStep: step } : null;
    const used = twoFactor.matchRecovery(user.totpRecovery, code);
    return used ? { totpRecovery: user.totpRecovery.filter((stored) => stored !== used) } : null;
  }

  app.post("/api/auth/login/2fa", async (request, reply) => {
    const { challenge, code } = parseBody(TwoFactorLoginBody, request.body);
    const userId = twoFactor.readChallenge(challenge);
    if (!userId) throw new HttpError(401, "challenge_expired", "That took too long — sign in again");
    const keys = [`2fa:${userId}`];
    if (await loginLimiter.isBlocked(keys)) throw tooMany();
    const user = await db.user.findUnique({ where: { id: userId } });
    const accepted = user?.totpEnabled ? accept(user, code) : null;
    if (!user || !accepted) {
      await loginLimiter.recordFailure(keys);
      throw new HttpError(401, "wrong_code", "That code isn't right (or was already used)");
    }
    await loginLimiter.reset(keys);
    await db.user.update({ where: { id: user.id }, data: accepted });
    const session = await sessions.create(user.id);
    setSessionCookie(reply, config, session.token, session.expiresAt);
    return { user: toUserDto(user) };
  });

  app.post("/api/auth/2fa/setup", async (request) => {
    const user = requireUser(request, "guest", { allowTwoFactorSetup: true });
    if (user.totpEnabled) throw conflict("Two-factor sign-in is already on");
    const enrolment = await twoFactor.enrolment(user.email);
    await db.user.update({ where: { id: user.id }, data: { totpSecret: twoFactor.encrypt(enrolment.secret), totpEnabled: false } });
    return enrolment;
  });

  app.post("/api/auth/2fa/enable", async (request) => {
    const user = requireUser(request, "guest", { allowTwoFactorSetup: true });
    const { code } = parseBody(EnableTwoFactorBody, request.body);
    if (user.totpEnabled) throw conflict("Two-factor sign-in is already on");
    const secret = user.totpSecret ? twoFactor.decrypt(user.totpSecret) : null;
    if (!secret) throw conflict("Start again: set up the app first");
    const step = twoFactor.check(secret, code);
    if (step === null) throw new HttpError(400, "wrong_code", "That code isn't right — check the app and try the current one");
    const { codes, hashes } = twoFactor.recoveryCodes();
    await db.user.update({ where: { id: user.id }, data: { totpEnabled: true, totpLastStep: step, totpRecovery: hashes } });
    return { recoveryCodes: codes };
  });

  app.post("/api/auth/2fa/disable", async (request) => {
    const user = requireUser(request);
    const { password } = parseBody(DisableTwoFactorBody, request.body);
    if (twoFactorPolicy.covers(user, await twoFactorPolicy.requirement())) throw conflict("Two-factor sign-in is required for your account");
    const keys = [`user:${user.id}`];
    if (await loginLimiter.isBlocked(keys)) throw tooMany();
    if (!(await verifyPassword(user.passwordHash, password))) {
      await loginLimiter.recordFailure(keys);
      throw new HttpError(401, "invalid_credentials", "Wrong password");
    }
    await db.user.update({ where: { id: user.id }, data: OFF });
    return { user: toUserDto({ ...user, ...OFF }) };
  });

  /** For someone who lost their phone and recovery codes. */
  app.post<{ Params: { id: string } }>("/api/users/:id/disable-2fa", async (request) => {
    requireUser(request, "admin");
    const id = parseId(request.params.id, "User");
    if (!(await db.user.findUnique({ where: { id } }))) throw notFound("User");
    return { user: toUserDto(await db.user.update({ where: { id }, data: OFF })) };
  });
}
