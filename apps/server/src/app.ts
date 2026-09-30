import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { Prisma, type Db } from "@ganttlines/db";
import Fastify, { type FastifyInstance } from "fastify";
import { AccessService } from "./auth/access";
import { LoginLimiter } from "./auth/login-limiter";
import { SESSION_COOKIE, SessionStore } from "./auth/sessions";
import { InstanceService } from "./calendar/instance-service";
import type { Config } from "./config";
import { forbidden, HttpError } from "./errors";
import { ProjectService } from "./projects/project-service";
import { KeyedQueue } from "./queue";
import { Hub } from "./realtime/hub";
import { activityRoutes } from "./routes/activity";
import { authRoutes } from "./routes/auth";
import { baselineRoutes } from "./routes/baselines";
import { calendarRoutes } from "./routes/calendar";
import { commandRoutes } from "./routes/commands";
import { commentRoutes } from "./routes/comments";
import { setSessionCookie, type RouteContext } from "./routes/context";
import { highlightRoutes } from "./routes/highlights";
import { projectRoutes } from "./routes/projects";
import { realtimeRoutes } from "./routes/realtime";
import { setupRoutes } from "./routes/setup";
import { sharingRoutes } from "./routes/sharing";
import { userRoutes } from "./routes/users";
import { webRoutes } from "./web";

export interface AppOptions {
  db: Db;
  config: Config;
  /** Clock for session expiry (tests) */
  now?: () => Date;
  logger?: boolean;
}

const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export async function buildApp({ db, config, now, logger = false }: AppOptions): Promise<FastifyInstance> {
  const hops = config.trustProxy;
  // A hop count N means "trust the N closest proxies" (proxy-addr trust function: hop 0 = direct peer).
  const trustProxy = typeof hops === "number" ? (_address: string, hop: number) => hop < hops : hops;
  const app = Fastify({ logger, trustProxy });
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  const instance = new InstanceService(db);
  const projects = new ProjectService(db, instance);
  const hub = new Hub();
  // Every committed change is pushed to the people looking at it.
  projects.onApplied(({ projectId, version, commandId, actor, changes }) =>
    hub.broadcast(projectId, { type: "patch", projectId, version, commandId, actor: { userId: actor.userId, label: actor.label }, changes }),
  );
  projects.onMetaChange((project) => hub.broadcast(project.id, { type: "project", project }));
  instance.onChange((snapshot) => hub.broadcastAll({ type: "instance", version: snapshot.version }));
  const context: RouteContext = {
    db,
    config,
    sessions: new SessionStore(db, config.sessionSecret, now),
    loginLimiter: new LoginLimiter(now ? () => now().getTime() : undefined),
    instance,
    projects,
    hub,
    access: new AccessService(db, config.sessionSecret),
    boardQueue: new KeyedQueue(),
    shareLimiter: new LoginLimiter(now ? () => now().getTime() : undefined),
  };

  // Expired sessions are also deleted when presented; this catches the ones that never come back.
  const cleanup = setInterval(() => {
    context.sessions.deleteExpired().catch((error: unknown) => app.log.error(error));
  }, SESSION_CLEANUP_INTERVAL_MS);
  cleanup.unref();
  app.addHook("onClose", async () => clearInterval(cleanup));

  app.decorateRequest("user", null);
  app.decorateRequest("sessionToken", null);

  // Reject cross-site state-changing requests (defence in depth on top of SameSite=Lax cookies).
  // WebSocket upgrades are GETs that carry the session cookie, so they must come from our own origin.
  app.addHook("onRequest", async (request) => {
    const upgrade = request.headers.upgrade?.toLowerCase() === "websocket";
    if (!upgrade && (request.method === "GET" || request.method === "HEAD")) return;
    const origin = request.headers.origin;
    const allowed = upgrade ? origin === config.publicUrl.origin : origin === undefined || origin === config.publicUrl.origin;
    if (!allowed) throw forbidden("Cross-origin request rejected");
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
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return reply.status(409).send({ error: "conflict", message: "That already exists" });
    }
    if (error instanceof HttpError) {
      if (error.status >= 500) request.log.error(error);
      return reply.status(error.status).send({ error: error.code, message: error.message });
    }
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
  commandRoutes(app, context);
  calendarRoutes(app, context);
  realtimeRoutes(app, context);
  sharingRoutes(app, context);
  commentRoutes(app, context);
  highlightRoutes(app, context);
  baselineRoutes(app, context);
  activityRoutes(app, context);
  if (config.webDir) await webRoutes(app, config.webDir);
  return app;
}
