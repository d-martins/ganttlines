import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { expect } from "vitest";
import { PUBLIC_URL } from "./helpers";

export const MCP_URL = `${PUBLIC_URL}/mcp`;
export const REDIRECT = "https://ai.example/callback";

/** `fetch`, answered by the app in-process (no port). */
export function injectFetch(app: FastifyInstance): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = Object.fromEntries(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
    const response = await app.inject({
      method: (init?.method ?? "GET") as "GET",
      url: url.pathname + url.search,
      headers,
      ...(init?.body ? { payload: String(init.body) } : {}),
    });
    return new Response(response.statusCode === 204 ? null : response.rawPayload, {
      status: response.statusCode,
      headers: response.headers as Record<string, string>,
    });
  };
}

export const enableMcp = (app: FastifyInstance, adminCookie: string, scopes = ["plans:read", "plans:write", "comments", "team:read"]) =>
  app.inject({ method: "PUT", url: "/api/settings/mcp", headers: { cookie: adminCookie }, payload: { enabled: true, scopes } });

export async function registerApp(app: FastifyInstance, name = "Test AI"): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/oauth/register", payload: { client_name: name, redirect_uris: [REDIRECT] } });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ client_id: string }>().client_id;
}

/**
 * The whole authorization: the app's request, the person's approval (signed in with `cookie`),
 * then the code exchanged for tokens. Returns the token response.
 */
export async function connect(app: FastifyInstance, cookie: string, clientId: string, options: { scopes?: string[]; grant?: string[] } = {}) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s-1",
    resource: MCP_URL,
    ...(options.scopes ? { scope: options.scopes.join(" ") } : {}),
  });
  const authorize = await app.inject({ url: `/oauth/authorize?${query}` });
  expect(authorize.statusCode).toBe(302);
  const request = new URL(authorize.headers.location as string).searchParams.get("request")!;
  expect(request, authorize.headers.location as string).toBeTruthy();
  const pending = await app.inject({ url: `/api/oauth/request?request=${encodeURIComponent(request)}`, headers: { cookie } });
  const grantable = pending.json<{ scopes: { scope: string; grantable: boolean; requested: boolean }[] }>().scopes;
  const consent = await app.inject({
    method: "POST",
    url: "/api/oauth/consent",
    headers: { cookie },
    payload: { request, approve: true, scopes: options.grant ?? grantable.filter((s) => s.grantable && s.requested).map((s) => s.scope) },
  });
  expect(consent.statusCode, consent.body).toBe(200);
  const back = new URL(consent.json<{ redirect: string }>().redirect);
  expect(back.searchParams.get("state")).toBe("s-1");
  expect(back.searchParams.get("iss")).toBe(PUBLIC_URL);
  const token = await app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource: MCP_URL,
    }).toString(),
  });
  expect(token.statusCode, token.body).toBe(200);
  return token.json<{ access_token: string; refresh_token: string; scope: string; expires_in: number }>();
}

/** An MCP client using `accessToken`, talking to the app in-process. */
export async function mcpClient(app: FastifyInstance, accessToken: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: injectFetch(app), requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }),
  );
  return client;
}

/** The data a tool answered (its structured content), or its error text. */
export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) return { error: (result.content as { text: string }[])[0]!.text };
  return result.structuredContent as Record<string, unknown>;
}
