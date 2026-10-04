import type { McpConnection, OAuthClient, User } from "@ganttlines/db";
import { CreateMcpTokenBody, McpSettingsBody, MCP_SCOPES, type McpConnectionDto, type McpScope, type McpSettingsDto } from "@ganttlines/protocol";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth/guard";
import { badRequest, conflict, forbidden, notFound } from "../errors";
import { NEVER_EXPIRES, scopesForRole } from "../oauth/grants";
import { parseBody, parseId } from "../validation";
import type { RouteContext } from "./context";
import { oauthUrls } from "./oauth";

type ConnectionRow = McpConnection & { client: OAuthClient | null; user?: User; tokens: { kind: string; expiresAt: Date }[] };

function toConnectionDto(connection: ConnectionRow): McpConnectionDto {
  const personal = connection.tokens.find((token) => token.kind === "personal");
  return {
    id: connection.id,
    app: connection.client?.name ?? connection.label ?? "Access token",
    kind: connection.client ? "app" : "token",
    ...(connection.client ? {} : { expiresAt: personal && personal.expiresAt < NEVER_EXPIRES ? personal.expiresAt.toISOString() : null }),
    scopes: connection.scopes as McpScope[],
    createdAt: connection.createdAt.toISOString(),
    lastUsedAt: connection.lastUsedAt?.toISOString() ?? null,
    ...(connection.user ? { user: { id: connection.user.id, name: connection.user.name, email: connection.user.email } } : {}),
  };
}

/** The admins' AI access settings, and the connected AI apps (your own; admins see everyone's). */
export function mcpSettingsRoutes(app: FastifyInstance, { db, config, mcpSettings, oauthGrants }: RouteContext): void {
  const url = oauthUrls(config.publicUrl).resource;

  app.get("/api/settings/mcp", async (request): Promise<McpSettingsDto> => {
    requireUser(request, "admin");
    return { ...(await mcpSettings.read()), url };
  });

  app.put("/api/settings/mcp", async (request): Promise<McpSettingsDto> => {
    requireUser(request, "admin");
    const { enabled, scopes } = parseBody(McpSettingsBody, request.body);
    await mcpSettings.write(enabled, scopes);
    return { ...(await mcpSettings.read()), url };
  });

  /** For everyone's Settings: whether AI apps can connect, where, and which groups this person can grant. */
  app.get("/api/mcp/available", async (request) => {
    const user = requireUser(request, "viewer");
    const settings = await mcpSettings.read();
    const forRole = scopesForRole(user.role);
    return { enabled: settings.enabled, url, scopes: settings.enabled ? settings.scopes.filter((scope) => forRole.includes(scope)) : [] };
  });

  app.get<{ Querystring: { all?: string } }>("/api/mcp/connections", async (request) => {
    const user = requireUser(request, "viewer");
    const everyone = request.query.all === "true";
    if (everyone && user.role !== "admin") throw forbidden();
    const connections = await db.mcpConnection.findMany({
      where: everyone ? {} : { userId: user.id },
      include: { client: true, user: everyone, tokens: { where: { kind: "personal" }, select: { kind: true, expiresAt: true } } },
      orderBy: { createdAt: "asc" },
    });
    return { connections: connections.map(toConnectionDto) };
  });

  /**
   * A personal access token for AI apps that take a token instead of signing in: the groups it may
   * use are limited like an app's (allowed by the admin and the person's role). Shown once.
   */
  app.post("/api/mcp/tokens", async (request, reply) => {
    const user = requireUser(request, "viewer");
    const body = parseBody(CreateMcpTokenBody, request.body);
    const settings = await mcpSettings.read();
    if (!settings.enabled) throw conflict("AI access is turned off on this server");
    const forRole = scopesForRole(user.role);
    const scopes = MCP_SCOPES.filter((scope) => body.scopes.includes(scope) && settings.scopes.includes(scope) && forRole.includes(scope));
    if (scopes.length === 0) throw badRequest("Choose at least one thing the token may do");
    const { token, connection, expiresAt } = await oauthGrants.createPersonalToken(user.id, body.name, scopes, body.expiresInDays);
    const dto = toConnectionDto({ ...connection, client: null, tokens: [{ kind: "personal", expiresAt }] });
    return reply.status(201).send({ token, connection: dto });
  });

  /** Disconnecting an app: its tokens stop working at once (approving it again starts afresh). */
  app.delete<{ Params: { id: string } }>("/api/mcp/connections/:id", async (request, reply) => {
    const user = requireUser(request, "viewer");
    const id = parseId(request.params.id, "Connection");
    const connection = await db.mcpConnection.findUnique({ where: { id } });
    if (!connection || (connection.userId !== user.id && user.role !== "admin")) throw notFound("Connection");
    await db.mcpConnection.delete({ where: { id } });
    return reply.status(204).send();
  });
}
