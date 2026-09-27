import cookie from "@fastify/cookie";
import type { Db } from "@ganttlines/db";
import Fastify, { type FastifyInstance } from "fastify";
import { LoginLimiter } from "./auth/login-limiter";
import { SESSION_COOKIE, SessionStore } from "./auth/sessions";
import type { Config } from "./config";
import { forbidden, HttpError } from "./errors";
import { authRoutes } from "./routes/auth";
import { setSessionCookie, type RouteContext } from "./routes/context";
import { projectRoutes } from "./routes/projects";
import { setupRoutes } from "./routes/setup";
import { userRoutes } from "./routes/users";

export interface AppOptions {
  db: Db;
  config: Config;
  /** Clock for session expiry (tests) */
  now?: () => Date;
  logger?: boolean;
}

export async function buildApp({ db, config, now, logger = false }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger, trustProxy: true });
  await app.register(cookie);

  const context: RouteContext = {
    db,
    config,
    sessions: new SessionStore(db, config.sessionSecret, now),
    loginLimiter: new LoginLimiter(now ? () => now().getTime() : undefined),
  };

  app.decorateRequest("user", null);
  app.decorateRequest("sessionToken", null);

  // Reject cross-site state-changing requests (defence in depth on top of SameSite=Lax cookies).
  app.addHook("onRequest", async (request) => {
    if (request.method === "GET" || request.method === "HEAD") return;
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== config.publicUrl.origin) throw forbidden("Cross-origin request rejected");
  });

  app.addHook("onRequest", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    const resolved = await context.sessions.resolve(token);
    if (!resolved) return;
    request.user = resolved.user;
    request.sessionToken = token;
    if (resolved.refreshedUntil) setSessionCookie(reply, config, token, resolved.refreshedUntil);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) return reply.status(error.status).send({ error: error.code, message: error.message });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: "invalid_request", message: (error as Error).message });
    }
    request.log.error(error);
    return reply.status(500).send({ error: "internal", message: "Something went wrong" });
  });

  app.get("/api/health", async () => ({ ok: true }));
  setupRoutes(app, context);
  authRoutes(app, context);
  userRoutes(app, context);
  projectRoutes(app, context);
  return app;
}
