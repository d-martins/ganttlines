import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { Prisma, type Db } from "@ganttlines/db";
import { pendingStepOf } from "./auth/guard";
import Fastify, { type FastifyInstance, type FastifyLoggerOptions, type FastifyRequest } from "fastify";
import type { PinoLoggerOptions } from "fastify/types/logger";

type LoggerOption = boolean | (FastifyLoggerOptions & PinoLoggerOptions);
import { AccessService } from "./auth/access";
import { FirstRun } from "./auth/first-run";
import { OidcSignIn } from "./auth/oidc";
import { PasswordTokens } from "./auth/password-tokens";
import { TwoFactor } from "./auth/two-factor";
import { smtpMailer, type Mailer } from "./mail/mailer";
import { MemoryLimiter, PgLimiter, type LimitOptions } from "./auth/limiter";
import { SESSION_COOKIE, SessionStore } from "./auth/sessions";
import { TwoFactorPolicy } from "./auth/two-factor-policy";
import { createCluster } from "./cluster";
import { MemoryUndoStore, PgUndoStore } from "./projects/undo-store";
import type { Cluster } from "./cluster/types";
import { Live } from "./realtime/live";
import { Presence } from "./realtime/presence";
import { mcpRoutes } from "./mcp/endpoint";
import { TeamEdits } from "./calendar/team-edits";
import { fetchMetadata, OAuthClients, type MetadataFetcher } from "./oauth/clients";
import { OAuthGrants } from "./oauth/grants";
import { McpSettings } from "./oauth/mcp-settings";
import { mcpSettingsRoutes } from "./routes/mcp-settings";
import { isOAuthPath, oauthRoutes } from "./routes/oauth";
import { InstanceService } from "./calendar/instance-service";
import type { Config } from "./config";
import { forbidden, HttpError } from "./errors";
import { ProjectService } from "./projects/project-service";
import { KeyedQueue } from "./queue";
import { Hub } from "./realtime/hub";
import { aboutRoutes } from "./routes/about";
import { activityRoutes } from "./routes/activity";
import { locationRoutes } from "./routes/locations";
import { oidcRoutes } from "./routes/oidc";
import { twoFactorRoutes } from "./routes/two-factor";
import { authRoutes } from "./routes/auth";
import { baselineRoutes, listBaselines } from "./routes/baselines";
import { calendarRoutes } from "./routes/calendar";
import { commandRoutes } from "./routes/commands";
import { commentRoutes, toCommentDto } from "./routes/comments";
import { setSessionCookie, type RouteContext } from "./routes/context";
import { highlightRoutes, listHighlights } from "./routes/highlights";
import { projectRoutes } from "./routes/projects";
import { realtimeRoutes } from "./routes/realtime";
import { setupRoutes } from "./routes/setup";
import { sharingRoutes } from "./routes/sharing";
import { userRoutes } from "./routes/users";
import { UpdateChecker } from "./updates";
import { webRoutes } from "./web";

declare module "fastify" {
  interface FastifyInstance {
    /** Stops this server being picked by load balancers (health answers 503); `close()` follows. */
    drain(): void;
  }
}

export interface AppOptions {
  /** where first-run messages (the setup code) go; the server prints them */
  announce?: (message: string) => void;
  /** outgoing email (tests pass an outbox); defaults to SMTP from the settings */
  mailer?: Mailer | null;
  /** a fixed first-run setup code (tests) */
  setupCode?: string;
  /** asks GitHub for new releases (tests pass a fake) */
  updates?: UpdateChecker;
  db: Db;
  config: Config;
  /** Clock for session expiry (tests) */
  now?: () => Date;
  /** the shared-state pieces (tests pass their own); made from the config otherwise */
  cluster?: Cluster;
  /** with several copies, how often live connections are checked against the database (tests shorten it) */
  liveRevalidateMs?: number;
  /** reads AI apps' client metadata documents (tests pass a fake) */
  fetchClientMetadata?: MetadataFetcher;
  logger?: LoggerOption;
}

const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export async function buildApp({
  db,
  config,
  now,
  logger = false,
  updates = new UpdateChecker(),
  announce = () => undefined,
  setupCode,
  mailer,
  fetchClientMetadata = fetchMetadata,
  liveRevalidateMs = 30_000,
  cluster: givenCluster,
}: AppOptions): Promise<FastifyInstance> {
  const clock = now ?? (() => new Date());
  const hops = config.trustProxy;
  // A hop count N means "trust the N closest proxies" (proxy-addr trust function: hop 0 = direct peer).
  const trustProxy = typeof hops === "number" ? (_address: string, hop: number) => hop < hops : hops;
  const app = Fastify({ logger: withRedactedUrls(logger), trustProxy });
  await app.register(cookie);
  await app.register(websocket, {
    options: { maxPayload: 1024 * 1024 },
    // On close, browsers get "going away": they reconnect — to another copy — and catch up.
    preClose(this: FastifyInstance, done: () => void) {
      for (const client of this.websocketServer.clients) client.close(1001, "Server restarting");
      this.websocketServer.close();
      done();
    },
  });

  const cluster = givenCluster ?? (await createCluster(config, (message, error) => (error ? app.log.error(error, message) : app.log.warn(message))));
  app.addHook("onClose", () => cluster.close());
  const instance = new InstanceService(db, cluster.lock, cluster.mode === "postgres");
  const projects = new ProjectService(db, instance, {
    lock: cluster.lock,
    shared: cluster.mode === "postgres",
    bus: cluster.bus,
    undo: cluster.mode === "postgres" ? new PgUndoStore(db) : new MemoryUndoStore(),
  });
  const hub = new Hub();
  const nowMs = now ? () => now().getTime() : Date.now;
  const access = new AccessService(db, config.sessionSecret, cluster.mode === "single", nowMs);
  const presence = new Presence(hub, cluster.bus);
  presence.start();
  // onClose hooks run in reverse order, so this goodbye goes out before the cluster closes:
  // other copies drop this copy's viewers at once.
  app.addHook("onClose", () => presence.stop());
  const live = new Live(
    hub,
    cluster.bus,
    presence,
    {
      db,
      instance,
      access,
      highlights: (projectId) => listHighlights(db, projectId),
      baselines: (projectId) => listBaselines(db, projectId),
      comment: toCommentDto,
    },
    (message, error) => app.log.warn({ err: error }, message),
  );
  // Every committed change is pushed to the people looking at it (on every copy).
  projects.onApplied((event) => live.patch(event));
  projects.onMetaChange((project) => live.projectMeta(project));
  instance.onChange((snapshot) => live.instanceChanged(snapshot.version));
  // Rate limits: in memory with one copy; counted in the database (hashed keys) with several.
  const limit = (name: string, options?: LimitOptions) =>
    cluster.mode === "postgres" ? new PgLimiter(db, config.sessionSecret, name, options, nowMs) : new MemoryLimiter(nowMs, options);
  const twoFactor = new TwoFactor(config.sessionSecret, now ? () => now().getTime() : undefined);
  const context: RouteContext = {
    db,
    config,
    cluster,
    sessions: new SessionStore(db, config.sessionSecret, now),
    loginLimiter: limit("login"),
    instance,
    projects,
    hub,
    access,
    live,
    presence,
    boardQueue: new KeyedQueue(),
    shareLimiter: limit("share"),
    firstRun: new FirstRun(db, instance, announce, setupCode, cluster.mode === "postgres" ? twoFactor : null),
    mailer: mailer !== undefined ? mailer : config.smtp ? smtpMailer(config.smtp) : null,
    passwordTokens: new PasswordTokens(db, now),
    twoFactor,
    twoFactorPolicy: new TwoFactorPolicy(db),
    mcpSettings: new McpSettings(db),
    oauthClients: new OAuthClients(db, fetchClientMetadata, clock),
    oauthGrants: new OAuthGrants(db, config.sessionSecret, clock),
    registerLimiter: limit("register"),
    mcpBudget: limit("mcp", { windowMs: 60_000, max: 300, sliding: true }),
    teamEdits: new TeamEdits(instance),
  };
  await context.firstRun.start(config.initialAdmin);

  // Expired sessions are also deleted when presented; this catches the ones that never come back.
  const cleanup = setInterval(() => {
    // With several copies, one does it (whoever gets there first).
    void cluster.lock
      .tryRun("housekeeping", async () => {
        await context.sessions.deleteExpired();
        await context.oauthGrants.deleteExpired();
        await context.oauthClients.deleteUnused();
        for (const limiter of [context.loginLimiter, context.shareLimiter, context.registerLimiter, context.mcpBudget]) await limiter.deleteOld();
      })
      .catch((error: unknown) => app.log.error(error));
  }, SESSION_CLEANUP_INTERVAL_MS);
  cleanup.unref();
  app.addHook("onClose", async () => clearInterval(cleanup));

  app.decorateRequest("user", null);
  app.decorateRequest("sessionToken", null);
  app.decorateRequest("pendingStep", null);

  // Reject cross-site state-changing requests (defence in depth on top of SameSite=Lax cookies).
  // WebSocket upgrades are GETs that carry the session cookie, so they must come from our own origin.
  // AI apps call the OAuth and MCP endpoints directly, possibly from a web page on another site.
  // They use bearer tokens (never cookies), so any site may call them; preflights are answered here.
  app.addHook("onRequest", async (request, reply) => {
    if (!isOAuthPath(request.url)) return;
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-expose-headers", "www-authenticate, mcp-session-id, mcp-protocol-version");
    if (request.method === "OPTIONS") {
      return reply
        .status(204)
        .header("access-control-allow-methods", "GET, POST, DELETE, OPTIONS")
        .header("access-control-allow-headers", "authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id")
        .header("access-control-max-age", "86400")
        .send();
    }
  });

  app.addHook("onRequest", async (request) => {
    if (isOAuthPath(request.url)) return;
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
    request.pendingStep = await pendingStepOf(context, resolved.user, resolved.viaSso);
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

  let draining = false;
  // Stop being picked by load balancers (health says 503); `close()` follows.
  app.decorate("drain", () => {
    draining = true;
  });
  app.get("/api/health", async (_request, reply) => {
    if (draining) return reply.status(503).send({ ok: false, reason: "stopping" });
    if (!cluster.bus.ready) return reply.status(503).send({ ok: false, reason: "not listening for other copies" });
    try {
      await db.$queryRaw`SELECT 1`;
    } catch {
      return reply.status(503).send({ ok: false, reason: "database unreachable" });
    }
    return { ok: true };
  });
  setupRoutes(app, context);
  authRoutes(app, context);
  userRoutes(app, context);
  projectRoutes(app, context);
  commandRoutes(app, context);
  calendarRoutes(app, context);
  realtimeRoutes(app, context, { revalidateMs: liveRevalidateMs });
  sharingRoutes(app, context);
  commentRoutes(app, context);
  highlightRoutes(app, context);
  baselineRoutes(app, context);
  activityRoutes(app, context);
  aboutRoutes(app, context, updates);
  twoFactorRoutes(app, context);
  locationRoutes(app, context);
  oauthRoutes(app, context);
  mcpSettingsRoutes(app, context);
  mcpRoutes(app, context);
  oidcRoutes(app, context, config.oidc ? new OidcSignIn(config.oidc, new URL("/api/auth/oidc/callback", config.publicUrl).toString(), config.sessionSecret) : null);
  if (config.webDir) await webRoutes(app, config.webDir);
  // (Fastify's own would log the address, tokens and all)
  else app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: "not_found", message: "Not found" }));
  return app;
}

/** Share-link and password-reset tokens travel in addresses; the request log shows them as [redacted]. */
export function redactUrl(url: string): string {
  const [path = "", query] = url.split("?", 2);
  const safePath = path.replace(/^\/(api\/share|s)\/[^/]+/, "/$1/[redacted]");
  const safeQuery = query?.replace(/(^|&)(share|token)=[^&]*/g, "$1$2=[redacted]");
  return safeQuery === undefined ? safePath : `${safePath}?${safeQuery}`;
}

function withRedactedUrls(logger: LoggerOption): LoggerOption {
  if (!logger) return logger;
  const serializers = {
    req: (request: FastifyRequest) => {
      const port = request.socket?.remotePort;
      return { method: request.method, url: redactUrl(request.url), host: request.host, remoteAddress: request.ip, ...(port === undefined ? {} : { remotePort: port }) };
    },
  };
  return logger === true ? { serializers } : { ...logger, serializers: { ...logger.serializers, ...serializers } };
}
