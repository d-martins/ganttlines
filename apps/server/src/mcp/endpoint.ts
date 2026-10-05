import type { McpScope } from "@ganttlines/protocol";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { notFound } from "../errors";
import { scopesForRole } from "../oauth/grants";
import type { RouteContext } from "../routes/context";
import { oauthUrls } from "../routes/oauth";
import { comments } from "./comments";
import { readPlans } from "./plans-read";
import { writePlans } from "./plans-write";
import { readTeam } from "./team-read";
import { writeTeam } from "./team-write";
import type { McpCaller, ToolGroup } from "./tools";

const GROUPS: Record<McpScope, ToolGroup> = {
  "plans:read": readPlans,
  "plans:write": writePlans,
  comments,
  "team:read": readTeam,
  "team:write": writeTeam,
};

const INSTRUCTIONS =
  "GanttLines is a team's Gantt planner. Projects are boards of sections and tasks; tasks have working-day durations, " +
  "can follow a predecessor (with a lag), and are scheduled around weekends, holidays and their assignee's time off. " +
  "Look projects and people up by name or id; dates are YYYY-MM-DD. Changes show up live for everyone, credited to the person " +
  "who connected this app; undo reverts this app's last board change.";

/**
 * The MCP endpoint for AI apps. Each request is served on its own (no sessions): the bearer token
 * names the connection, and the server built for it offers only the tool groups that the admin
 * allows, the person granted that app, and the person's role permits.
 */
export function mcpRoutes(app: FastifyInstance, context: RouteContext): void {
  const { config, mcpSettings, oauthGrants } = context;
  const urls = oauthUrls(config.publicUrl);

  const handler = createMcpHandler(({ authInfo }) => {
    const caller = authInfo?.extra?.["caller"] as McpCaller;
    const server = new McpServer({ name: "GanttLines", version: config.version }, { instructions: INSTRUCTIONS });
    for (const scope of caller.scopes) GROUPS[scope](server, { context, caller });
    return server;
  });

  const challenge = (reply: FastifyReply, error?: string) =>
    reply
      .status(401)
      .header("www-authenticate", `Bearer resource_metadata="${urls.resourceMetadata}"${error ? `, error="${error}"` : ""}`)
      .send({ error: error ?? "unauthorized", message: "Connect this app to GanttLines first (sign in through the app)" });

  async function serve(request: FastifyRequest, reply: FastifyReply) {
    const settings = await mcpSettings.read();
    if (!settings.enabled) throw notFound("AI access");
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
    if (!token) return challenge(reply);
    const access = await oauthGrants.verifyAccess(token);
    // The person must still be able to use the app: an admin's later changes apply at once.
    if (!access || access.user.mustChangePassword || access.user.role === "guest") return challenge(reply, "invalid_token");
    // Requests per connection per minute (an AI app working through a plan stays well under).
    const budgetKey = [access.connection.id];
    if (!(await context.mcpBudget.attempt(budgetKey))) {
      return reply.status(429).header("retry-after", "60").send({ error: "too_many_requests", message: "Too many requests from this app — wait a minute" });
    }
    const forRole = scopesForRole(access.user.role);
    const scopes = access.scopes.filter((scope) => settings.scopes.includes(scope) && forRole.includes(scope));
    await oauthGrants.touch(access.connection);
    const caller: McpCaller = { user: access.user, app: access.app, connectionId: access.connection.id, scopes };

    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers.set(name, value);
      else if (Array.isArray(value)) headers.set(name, value.join(", "));
    }
    const init: RequestInit = { method: request.method, headers };
    if (request.method === "POST") init.body = JSON.stringify(request.body ?? null);
    const response = await handler.fetch(new Request(urls.resource, init), {
      authInfo: {
        token,
        clientId: access.connection.clientId ?? `token:${access.connection.id}`,
        scopes,
        expiresAt: Math.floor(access.expiresAt.getTime() / 1000),
        resource: new URL(urls.resource),
        extra: { caller },
      },
    });
    reply.status(response.status);
    response.headers.forEach((value, name) => {
      if (name !== "content-length") reply.header(name, value);
    });
    return reply.send(response.body ? Readable.fromWeb(response.body as WebReadableStream) : null);
  }

  app.route({ method: ["GET", "POST", "DELETE"], url: "/mcp", handler: serve });
}
