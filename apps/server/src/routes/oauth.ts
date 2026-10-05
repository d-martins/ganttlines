import { MCP_SCOPES, OAuthConsentBody, type McpScope, type OAuthRequestDto } from "@ganttlines/protocol";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireUser } from "../auth/guard";
import { badRequest, HttpError, notFound } from "../errors";
import { OAuthFailure, redirectMatches } from "../oauth/clients";
import { parseScopes, scopesForRole, type AuthorizationRequest } from "../oauth/grants";
import { parseBody } from "../validation";
import type { RouteContext } from "./context";

/** This server's addresses as an OAuth authorization server and as the MCP resource. */
export function oauthUrls(publicUrl: URL) {
  const base = publicUrl.href.replace(/\/$/, "");
  return {
    issuer: base,
    resource: `${base}/mcp`,
    resourceMetadata: `${base}/.well-known/oauth-protected-resource/mcp`,
    connectPage: `${base}/connect`,
  };
}

/** Paths AI apps call directly (no cookies, possibly from another site): bearer tokens or public. */
export const isOAuthPath = (url: string) => /^\/(oauth\/|mcp(\?|$)|\.well-known\/oauth-)/.test(url);

const turnedOff = () => notFound("AI access");

/** Where the redirect is going, in words: the host, or the app's own scheme. */
function redirectHost(uri: string): string {
  const url = new URL(uri);
  return url.host || url.protocol.replace(/:$/, "");
}

/**
 * OAuth 2.1 for AI apps connecting over MCP: discovery documents, app registration (or client
 * metadata documents), the authorization step (which hands over to the web app's "Allow access?"
 * page), and tokens.
 */
export function oauthRoutes(app: FastifyInstance, context: RouteContext): void {
  const { config, mcpSettings, oauthClients, oauthGrants, registerLimiter } = context;
  const urls = oauthUrls(config.publicUrl);

  const enabled = async () => (await mcpSettings.read()).enabled;
  const redirectWith = (request: Pick<AuthorizationRequest, "redirectUri" | "state">, params: Record<string, string>) => {
    const url = new URL(request.redirectUri);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (request.state !== null) url.searchParams.set("state", request.state);
    url.searchParams.set("iss", urls.issuer);
    return url.toString();
  };
  const oauthError = (reply: FastifyReply, error: OAuthFailure) =>
    reply.status(error.status).header("cache-control", "no-store").send({ error: error.code, error_description: error.message });

  const protectedResource = async (_request: unknown, reply: FastifyReply) => {
    if (!(await enabled())) throw turnedOff();
    return reply.send({
      resource: urls.resource,
      authorization_servers: [urls.issuer],
      scopes_supported: MCP_SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: "GanttLines",
    });
  };
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  app.get("/.well-known/oauth-authorization-server", async () => {
    if (!(await enabled())) throw turnedOff();
    return {
      issuer: urls.issuer,
      authorization_endpoint: `${urls.issuer}/oauth/authorize`,
      token_endpoint: `${urls.issuer}/oauth/token`,
      registration_endpoint: `${urls.issuer}/oauth/register`,
      revocation_endpoint: `${urls.issuer}/oauth/revoke`,
      scopes_supported: MCP_SCOPES,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  });

  // OAuth requests are form-encoded; only these routes accept that (the app's own API stays JSON).
  app.register(async (scope) => {
    scope.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });

    scope.post("/oauth/register", async (request, reply) => {
      if (!(await enabled())) throw turnedOff();
      const keys = [`register:${request.ip}`];
      if (await registerLimiter.isBlocked(keys)) return oauthError(reply, new OAuthFailure("too_many_requests", "Too many registrations, try again later", 429));
      await registerLimiter.recordFailure(keys); // every registration counts
      try {
        return reply.status(201).header("cache-control", "no-store").send(await oauthClients.register(request.body));
      } catch (error) {
        if (error instanceof OAuthFailure) return oauthError(reply, error);
        throw error;
      }
    });

    scope.post("/oauth/token", async (request, reply) => {
      if (!(await enabled())) throw turnedOff();
      const body = (request.body ?? {}) as Record<string, unknown>;
      const text = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : "");
      try {
        if (body["resource"] !== undefined && text("resource").replace(/\/$/, "") !== urls.resource) {
          throw new OAuthFailure("invalid_target", "Tokens are only issued for this server's /mcp");
        }
        const clientId = text("client_id");
        await oauthClients.find(clientId).catch(() => {
          throw new OAuthFailure("invalid_client", "Unknown app", 401);
        });
        const tokens =
          text("grant_type") === "authorization_code"
            ? await oauthGrants.exchangeCode({ code: text("code"), clientId, redirectUri: text("redirect_uri"), verifier: text("code_verifier") })
            : text("grant_type") === "refresh_token"
              ? await oauthGrants.refresh({ refreshToken: text("refresh_token"), clientId })
              : null;
        if (!tokens) throw new OAuthFailure("unsupported_grant_type", "Use authorization_code or refresh_token");
        return reply.header("cache-control", "no-store").send(tokens);
      } catch (error) {
        if (error instanceof OAuthFailure) return oauthError(reply, error);
        throw error;
      }
    });

    scope.post("/oauth/revoke", async (request, reply) => {
      const token = (request.body as Record<string, unknown> | undefined)?.["token"];
      if (typeof token === "string") await oauthGrants.revoke(token);
      return reply.status(200).send({});
    });
  });

  /**
   * Checks the app's request, then hands over to the "Allow access?" page with it signed. Problems
   * with the app or its redirect address are shown on that page (never redirected to an address we
   * can't trust); other problems go back to the app.
   */
  app.get<{ Querystring: Record<string, string | undefined> }>("/oauth/authorize", async (request, reply) => {
    if (!(await enabled())) return reply.redirect(`${urls.connectPage}?error=${encodeURIComponent("AI access is turned off on this server")}`);
    const query = request.query;
    let client;
    try {
      client = await oauthClients.find(query["client_id"] ?? "");
    } catch (error) {
      const message = error instanceof OAuthFailure ? error.message : "Unknown app";
      return reply.redirect(`${urls.connectPage}?error=${encodeURIComponent(message)}`);
    }
    const given = query["redirect_uri"];
    const redirectUri = given ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
    if (!redirectUri || !client.redirectUris.some((registered) => redirectMatches(registered, redirectUri))) {
      return reply.redirect(`${urls.connectPage}?error=${encodeURIComponent("The app's return address doesn't match its registration")}`);
    }
    const state = query["state"] ?? null;
    const fail = (error: string, description: string) => reply.redirect(redirectWith({ redirectUri, state }, { error, error_description: description }));
    if (query["response_type"] !== "code") return fail("unsupported_response_type", "Only response_type=code is supported");
    if (!query["code_challenge"] || query["code_challenge_method"] !== "S256") return fail("invalid_request", "PKCE with S256 is required");
    if (query["resource"] !== undefined && query["resource"].replace(/\/$/, "") !== urls.resource) {
      return fail("invalid_target", "This server only issues tokens for its /mcp");
    }
    const scopes = query["scope"] === undefined ? [...MCP_SCOPES] : parseScopes(query["scope"]);
    const signed = context.oauthGrants.signRequest({ clientId: client.id, redirectUri, codeChallenge: query["code_challenge"], state, scopes });
    return reply.redirect(`${urls.connectPage}?request=${encodeURIComponent(signed)}`);
  });

  /** For the "Allow access?" page: the app, and which groups the signed-in person can grant it. */
  async function pending(signed: string, role: Parameters<typeof scopesForRole>[0]) {
    const settings = await mcpSettings.read();
    if (!settings.enabled) throw new HttpError(404, "not_found", "AI access is turned off on this server");
    const request = oauthGrants.readRequest(signed);
    if (!request) throw badRequest("This request has expired — start connecting again from the app");
    const client = await oauthClients.find(request.clientId).catch(() => {
      throw badRequest("Unknown app — start connecting again from the app");
    });
    const forRole = scopesForRole(role);
    const grantable = (scope: McpScope) => settings.scopes.includes(scope) && forRole.includes(scope);
    return { request, client, grantable };
  }

  app.get<{ Querystring: { request?: string } }>("/api/oauth/request", async (request): Promise<OAuthRequestDto> => {
    const user = requireUser(request, "viewer");
    const { request: authorization, client, grantable } = await pending(request.query.request ?? "", user.role);
    return {
      app: { name: client.name, redirectHost: redirectHost(authorization.redirectUri) },
      scopes: MCP_SCOPES.map((scope) => ({ scope, grantable: grantable(scope), requested: authorization.scopes.includes(scope) })),
    };
  });

  app.post("/api/oauth/consent", async (request) => {
    const user = requireUser(request, "viewer");
    const body = parseBody(OAuthConsentBody, request.body);
    const { request: authorization, client, grantable } = await pending(body.request, user.role);
    if (!body.approve) return { redirect: redirectWith(authorization, { error: "access_denied", error_description: "The person declined" }) };
    const scopes = MCP_SCOPES.filter((scope) => body.scopes.includes(scope) && grantable(scope));
    if (scopes.length === 0) throw badRequest("Choose at least one thing the app may do");
    const connection = await oauthGrants.approve(user.id, client.id, scopes);
    const code = await oauthGrants.issueCode(connection.id, authorization, scopes);
    return { redirect: redirectWith(authorization, { code }) };
  });
}
