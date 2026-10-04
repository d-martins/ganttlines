import type { McpConnection, OAuthClient, User } from "@ganttlines/db";
import { McpSettingsBody, type McpConnectionDto, type McpScope, type McpSettingsDto } from "@ganttlines/protocol";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth/guard";
import { forbidden, notFound } from "../errors";
import { parseBody, parseId } from "../validation";
import type { RouteContext } from "./context";
import { oauthUrls } from "./oauth";

function toConnectionDto(connection: McpConnection & { client: OAuthClient; user?: User }): McpConnectionDto {
  return {
    id: connection.id,
    app: connection.client.name,
    scopes: connection.scopes as McpScope[],
    createdAt: connection.createdAt.toISOString(),
    lastUsedAt: connection.lastUsedAt?.toISOString() ?? null,
    ...(connection.user ? { user: { id: connection.user.id, name: connection.user.name, email: connection.user.email } } : {}),
  };
}

/** The admins' AI access settings, and the connected AI apps (your own; admins see everyone's). */
export function mcpSettingsRoutes(app: FastifyInstance, { db, config, mcpSettings }: RouteContext): void {
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

  app.get<{ Querystring: { all?: string } }>("/api/mcp/connections", async (request) => {
    const user = requireUser(request, "viewer");
    const everyone = request.query.all === "true";
    if (everyone && user.role !== "admin") throw forbidden();
    const connections = await db.mcpConnection.findMany({
      where: everyone ? {} : { userId: user.id },
      include: { client: true, user: everyone },
      orderBy: { createdAt: "asc" },
    });
    return { connections: connections.map(toConnectionDto) };
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
