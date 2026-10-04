import { describe, expect, it } from "vitest";
import { createUser, PUBLIC_URL, setupAdmin, testApp, testConfig, useTestApp } from "./helpers";
import { connect, enableMcp, MCP_URL, REDIRECT, registerApp } from "./mcp-support";

const t = useTestApp();

const form = (fields: Record<string, string>) => ({
  method: "POST" as const,
  url: "/oauth/token",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  payload: new URLSearchParams(fields).toString(),
});

describe("AI access: OAuth", () => {
  it("is off until an admin turns it on, then describes itself to AI apps", async () => {
    const admin = await setupAdmin(t.app);
    for (const url of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server", "/mcp"]) {
      expect((await t.app.inject({ url })).statusCode).toBe(404);
    }
    expect((await t.app.inject({ method: "POST", url: "/oauth/register", payload: { redirect_uris: [REDIRECT] } })).statusCode).toBe(404);

    const settings = await enableMcp(t.app, admin);
    expect(settings.json()).toEqual({ enabled: true, scopes: ["plans:read", "plans:write", "comments", "team:read"], url: MCP_URL });
    const resource = (await t.app.inject({ url: "/.well-known/oauth-protected-resource/mcp" })).json();
    expect(resource).toMatchObject({ resource: MCP_URL, authorization_servers: [PUBLIC_URL] });
    const server = (await t.app.inject({ url: "/.well-known/oauth-authorization-server" })).json();
    expect(server).toMatchObject({
      issuer: PUBLIC_URL,
      authorization_endpoint: `${PUBLIC_URL}/oauth/authorize`,
      token_endpoint: `${PUBLIC_URL}/oauth/token`,
      registration_endpoint: `${PUBLIC_URL}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    // An app's first call is told where to sign in.
    const unauthorized = await t.app.inject({ method: "POST", url: "/mcp", payload: {} });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers["www-authenticate"]).toBe(`Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`);
    // Any site may call these (bearer tokens, no cookies).
    const preflight = await t.app.inject({ method: "OPTIONS", url: "/oauth/token", headers: { origin: "https://ai.example" } });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("*");
    // Only admins see or change the settings.
    const viewer = await createUser(t.app, admin, { email: "vi@example.com", name: "Vi", role: "viewer" });
    expect((await t.app.inject({ url: "/api/settings/mcp", headers: { cookie: viewer.cookie } })).statusCode).toBe(403);
  });

  it("registers apps, takes the person's approval, and exchanges the code (with PKCE) for tokens", async () => {
    const admin = await setupAdmin(t.app);
    await enableMcp(t.app, admin);
    const clientId = await registerApp(t.app);
    const tokens = await connect(t.app, admin, clientId, { grant: ["plans:read", "team:read"] });
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "plans:read team:read" });

    const mine = (await t.app.inject({ url: "/api/mcp/connections", headers: { cookie: admin } })).json().connections;
    expect(mine).toEqual([expect.objectContaining({ app: "Test AI", scopes: ["plans:read", "team:read"], lastUsedAt: null })]);

    // Approving the same app again replaces its groups (one connection per person and app).
    await connect(t.app, admin, clientId, { grant: ["plans:read"] });
    expect((await t.app.inject({ url: "/api/mcp/connections", headers: { cookie: admin } })).json().connections).toEqual([
      expect.objectContaining({ scopes: ["plans:read"] }),
    ]);
  });

  it("rejects codes used twice, wrong verifiers, and redirect addresses that weren't registered", async () => {
    const admin = await setupAdmin(t.app);
    await enableMcp(t.app, admin);
    const clientId = await registerApp(t.app);

    const elsewhere = await t.app.inject({
      url: `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://evil.example/cb", code_challenge: "x", code_challenge_method: "S256" })}`,
    });
    expect(elsewhere.headers.location).toMatch(/^http:\/\/localhost:3000\/connect\?error=/); // shown on our page, never sent there
    const unknown = await t.app.inject({ url: `/oauth/authorize?client_id=nope&redirect_uri=${encodeURIComponent(REDIRECT)}` });
    expect(unknown.headers.location).toMatch(/\/connect\?error=Unknown/);
    const noPkce = await t.app.inject({ url: `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, state: "z" })}` });
    const back = new URL(noPkce.headers.location as string);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(Object.fromEntries(back.searchParams)).toMatchObject({ error: "invalid_request", state: "z", iss: PUBLIC_URL });

    // Registration only takes safe redirect addresses.
    for (const redirect of ["http://ai.example/cb", "javascript:alert(1)", "https://ai.example/cb#x"]) {
      const bad = await t.app.inject({ method: "POST", url: "/oauth/register", payload: { redirect_uris: [redirect] } });
      expect(bad.json()).toMatchObject({ error: "invalid_redirect_uri" });
    }
    const desktop = await t.app.inject({ method: "POST", url: "/oauth/register", payload: { redirect_uris: ["http://127.0.0.1:33418/callback", "cursor://anysphere.cursor/oauth"] } });
    expect(desktop.statusCode).toBe(201);

    // A refresh token works once; presenting a spent one again ends that connection's tokens.
    const tokens = await connect(t.app, admin, clientId);
    const refreshed = await t.app.inject(form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }));
    expect(refreshed.statusCode).toBe(200);
    const fresh = refreshed.json<{ access_token: string; refresh_token: string }>();
    expect(fresh.refresh_token).not.toBe(tokens.refresh_token);
    const replay = await t.app.inject(form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }));
    expect(replay.json()).toMatchObject({ error: "invalid_grant" });
    const afterReplay = await t.app.inject(form({ grant_type: "refresh_token", refresh_token: fresh.refresh_token, client_id: clientId }));
    expect(afterReplay.json()).toMatchObject({ error: "invalid_grant" });
    expect((await t.app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${fresh.access_token}` }, payload: {} })).statusCode).toBe(401);
  });

  it("refuses PKCE verifiers that don't match", async () => {
    const admin = await setupAdmin(t.app);
    await enableMcp(t.app, admin);
    const clientId = await registerApp(t.app);
    const authorize = await t.app.inject({
      url: `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: "not-the-hash", code_challenge_method: "S256" })}`,
    });
    const request = new URL(authorize.headers.location as string).searchParams.get("request")!;
    const consent = await t.app.inject({ method: "POST", url: "/api/oauth/consent", headers: { cookie: admin }, payload: { request, approve: true, scopes: ["plans:read"] } });
    const code = new URL(consent.json().redirect).searchParams.get("code")!;
    const token = await t.app.inject(form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: "wrong" }));
    expect(token.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("offers each person only what the admin allows and their role permits; declining goes back to the app", async () => {
    const admin = await setupAdmin(t.app);
    await enableMcp(t.app, admin, ["plans:read", "plans:write"]);
    const viewer = await createUser(t.app, admin, { email: "vi@example.com", name: "Vi", role: "viewer" });
    const guest = await createUser(t.app, admin, { email: "gu@example.com", name: "Gu", role: "guest" });
    const clientId = await registerApp(t.app, "Claude");
    const authorize = await t.app.inject({
      url: `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: "c", code_challenge_method: "S256", scope: "plans:read plans:write" })}`,
    });
    const request = new URL(authorize.headers.location as string).searchParams.get("request")!;
    const pending = (await t.app.inject({ url: `/api/oauth/request?request=${encodeURIComponent(request)}`, headers: { cookie: viewer.cookie } })).json();
    expect(pending.app).toEqual({ name: "Claude", redirectHost: "ai.example" });
    expect(pending.scopes.filter((s: { grantable: boolean }) => s.grantable).map((s: { scope: string }) => s.scope)).toEqual(["plans:read"]);
    const tooMuch = await t.app.inject({ method: "POST", url: "/api/oauth/consent", headers: { cookie: viewer.cookie }, payload: { request, approve: true, scopes: ["plans:write"] } });
    expect(tooMuch.statusCode).toBe(400);
    expect((await t.app.inject({ url: `/api/oauth/request?request=${encodeURIComponent(request)}`, headers: { cookie: guest.cookie } })).statusCode).toBe(403);
    expect((await t.app.inject({ url: `/api/oauth/request?request=${encodeURIComponent(request)}` })).statusCode).toBe(401);

    const declined = await t.app.inject({ method: "POST", url: "/api/oauth/consent", headers: { cookie: viewer.cookie }, payload: { request, approve: false, scopes: [] } });
    expect(new URL(declined.json().redirect).searchParams.get("error")).toBe("access_denied");
    // A tampered request is refused.
    const forged = await t.app.inject({ url: `/api/oauth/request?request=${encodeURIComponent(`${request.split(".")[0]}.forged`)}`, headers: { cookie: viewer.cookie } });
    expect(forged.statusCode).toBe(400);
  });

  it("knows apps by their client metadata document", async () => {
    const fetched: string[] = [];
    const app = await testApp({
      db: t.db,
      config: testConfig,
      fetchClientMetadata: async (url) => {
        fetched.push(url.toString());
        return { client_id: url.toString(), client_name: "Claude", redirect_uris: [REDIRECT] };
      },
    });
    const admin = await setupAdmin(app);
    await enableMcp(app, admin);
    const clientId = "https://claude.example/oauth/client.json";
    const tokens = await connect(app, admin, clientId);
    expect(tokens.access_token).toBeTruthy();
    expect(fetched).toEqual([clientId]); // kept for a day, not fetched again
    expect((await app.inject({ url: "/api/mcp/connections", headers: { cookie: admin } })).json().connections[0].app).toBe("Claude");

    const liar = await testApp({ db: t.db, config: testConfig, fetchClientMetadata: async () => ({ client_id: "https://other.example/c.json", redirect_uris: [REDIRECT] }) });
    const refused = await liar.inject({ url: `/oauth/authorize?client_id=${encodeURIComponent("https://liar.example/c.json")}&redirect_uri=${encodeURIComponent(REDIRECT)}` });
    expect(decodeURIComponent(refused.headers.location as string)).toContain("names another client id");
    await Promise.all([app.close(), liar.close()]);
  });

  it("stops tokens when a person disconnects the app, or an admin turns AI access off", async () => {
    const admin = await setupAdmin(t.app);
    await enableMcp(t.app, admin);
    const editor = await createUser(t.app, admin, { email: "ed@example.com", name: "Ed", role: "editor" });
    const clientId = await registerApp(t.app);
    const mine = await connect(t.app, editor.cookie, clientId);
    const call = (token: string) =>
      t.app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
    expect((await call(mine.access_token)).statusCode).toBe(200);

    await t.app.inject({ method: "PUT", url: "/api/settings/mcp", headers: { cookie: admin }, payload: { enabled: false, scopes: ["plans:read"] } });
    expect((await call(mine.access_token)).statusCode).toBe(404);
    await enableMcp(t.app, admin);
    expect((await call(mine.access_token)).statusCode).toBe(200); // turning it back on restores connections

    const everyone = (await t.app.inject({ url: "/api/mcp/connections?all=true", headers: { cookie: admin } })).json().connections;
    expect(everyone).toEqual([expect.objectContaining({ app: "Test AI", user: expect.objectContaining({ name: "Ed" }) })]);
    expect((await t.app.inject({ url: "/api/mcp/connections?all=true", headers: { cookie: editor.cookie } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: "DELETE", url: `/api/mcp/connections/${everyone[0].id}`, headers: { cookie: editor.cookie } })).statusCode).toBe(204);
    expect((await call(mine.access_token)).statusCode).toBe(401);

    const revoked = await connect(t.app, editor.cookie, clientId);
    await t.app.inject({ ...form({ token: revoked.access_token }), url: "/oauth/revoke" });
    expect((await call(revoked.access_token)).statusCode).toBe(401);
  });
});
