import { randomBytes } from "node:crypto";
import type { User } from "@ganttlines/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import { actorOf } from "../actor";
import { OidcError, type OidcIdentity, type OidcSignIn } from "../auth/oidc";
import { hashPassword } from "../auth/passwords";
import { insertResource } from "../calendar/instance-service";
import { setSessionCookie, type RouteContext } from "./context";

const PENDING_COOKIE = "gp_oidc";
const PENDING_PATH = "/api/auth/oidc";

/** Only same-site paths, so the sign-in can't be used to bounce people to another site. */
const safeRedirect = (value: unknown) => (typeof value === "string" && /^\/(?![/\\])/.test(value) ? value : "/");

/**
 * Single sign-on with an OpenID Connect provider: `/start` sends the browser there, `/callback`
 * checks the answer and signs the person in — matching their account by the provider's id, or on
 * first use by their verified email; creating one only when OIDC_AUTO_CREATE is on.
 */
export function oidcRoutes(app: FastifyInstance, context: RouteContext, oidc: OidcSignIn | null): void {
  const { db, config, sessions, instance } = context;

  // What the sign-in page can offer besides email and password.
  app.get("/api/auth/providers", async () => ({ oidc: oidc ? { name: oidc.settings.name } : null, passwordReset: context.mailer !== null }));
  if (!oidc) return;

  const fail = (reply: FastifyReply, code: string) => reply.clearCookie(PENDING_COOKIE, { path: PENDING_PATH }).redirect(`/login?error=${code}`);

  app.get<{ Querystring: { redirect?: string } }>("/api/auth/oidc/start", async (request, reply) => {
    try {
      const { url, cookie } = await oidc.start(safeRedirect(request.query.redirect));
      reply.setCookie(PENDING_COOKIE, cookie, {
        path: PENDING_PATH,
        httpOnly: true,
        sameSite: "lax", // sent on the provider's top-level redirect back
        secure: config.publicUrl.protocol === "https:",
        maxAge: 600,
      });
      return reply.redirect(url);
    } catch (error) {
      request.log.error(error, "single sign-on: couldn't reach the provider");
      return fail(reply, "sso_failed");
    }
  });

  app.get("/api/auth/oidc/callback", async (request, reply) => {
    const currentUrl = new URL(request.url, config.publicUrl);
    let outcome: { identity: OidcIdentity; redirect: string };
    try {
      outcome = await oidc.finish(currentUrl, request.cookies[PENDING_COOKIE]);
    } catch (error) {
      if (!(error instanceof OidcError)) throw error;
      request.log.warn(error.message);
      return fail(reply, error.code);
    }
    const user = await accountFor(outcome.identity);
    if (!user) return fail(reply, "sso_no_account");
    const session = await sessions.create(user.id);
    setSessionCookie(reply, config, session.token, session.expiresAt);
    return reply.clearCookie(PENDING_COOKIE, { path: PENDING_PATH }).redirect(outcome.redirect);
  });

  /** The linked account; else the one with this (verified) email, linked now; else a new one if allowed. */
  async function accountFor({ subject, email, name }: OidcIdentity): Promise<User | null> {
    const linked = await db.user.findUnique({ where: { oidcSubject: subject } });
    if (linked) return linked;
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      if (existing.oidcSubject !== null) return null; // already tied to another account at the provider
      // An account waiting for its first sign-in: the temporary password an admin handed out stops working.
      const retire = existing.mustChangePassword ? { mustChangePassword: false, passwordHash: await unusablePassword() } : {};
      return db.user.update({ where: { id: existing.id }, data: { oidcSubject: subject, ...retire } });
    }
    if (!oidc!.settings.autoCreate) return null;
    const passwordHash = await unusablePassword();
    const role = oidc!.settings.defaultRole;
    return instance.mutate(actorOf, "createUser", { email }, async (tx) => {
      const created = await tx.user.create({ data: { email, name, role, passwordHash, oidcSubject: subject } });
      if (role !== "guest") await insertResource(tx, { name: created.name, userId: created.id });
      return created;
    });
  }
}

/** A random password nobody knows: the account signs in through the provider only (an admin can reset it). */
const unusablePassword = () => hashPassword(randomBytes(32).toString("base64url"));
