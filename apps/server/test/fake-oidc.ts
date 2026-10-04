import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

/** Who the fake provider says signed in. */
export interface FakeIdentity {
  sub: string;
  email: string;
  name?: string;
  email_verified?: boolean;
}

export interface FakeOidcProvider {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** approves an authorization request as `identity` (what the sign-in form does) and returns the redirect back */
  approve(authorizeUrl: string, identity: FakeIdentity): Promise<string>;
  close(): Promise<void>;
}

/**
 * A tiny OpenID Connect provider for tests: discovery, an authorization page with a sign-in form,
 * a token endpoint that checks PKCE, and RS256-signed ID tokens. http on localhost.
 */
export async function startFakeOidcProvider(port = 0): Promise<FakeOidcProvider> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256", use: "sig" };
  const clientId = "ganttlines-test";
  const clientSecret = "test-secret";
  const codes = new Map<string, { identity: FakeIdentity; nonce: string; challenge: string; redirectUri: string }>();
  let issuer = "";

  const approveParams = (params: URLSearchParams, identity: FakeIdentity) => {
    const code = randomBytes(16).toString("hex");
    codes.set(code, { identity, nonce: params.get("nonce") ?? "", challenge: params.get("code_challenge") ?? "", redirectUri: params.get("redirect_uri") ?? "" });
    const back = new URL(params.get("redirect_uri")!);
    back.searchParams.set("code", code);
    back.searchParams.set("state", params.get("state") ?? "");
    back.searchParams.set("iss", issuer);
    return back.toString();
  };

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", issuer);
    const body = await new Promise<string>((resolve) => {
      let data = "";
      request.on("data", (chunk) => (data += chunk));
      request.on("end", () => resolve(data));
    });
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      });
    }
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
    if (url.pathname === "/authorize" && request.method === "GET") {
      // A sign-in form that posts back here with the request's parameters.
      const hidden = [...url.searchParams].map(([key, value]) => `<input type="hidden" name="${key}" value="${value.replace(/"/g, "&quot;")}">`).join("");
      response.writeHead(200, { "content-type": "text/html" });
      return response.end(
        `<!doctype html><title>Test IdP</title><form method="post" action="/authorize">${hidden}` +
          `<label>Email <input name="email"></label><label>Name <input name="name"></label><button>Continue</button></form>`,
      );
    }
    if (url.pathname === "/authorize" && request.method === "POST") {
      const form = new URLSearchParams(body);
      const email = form.get("email") ?? "";
      response.writeHead(302, { location: approveParams(form, { sub: `sub-${email}`, email, name: form.get("name") || email, email_verified: true }) });
      return response.end();
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const form = new URLSearchParams(body);
      const basic = Buffer.from((request.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString();
      const [id, secret] = basic ? basic.split(":").map(decodeURIComponent) : [form.get("client_id"), form.get("client_secret")];
      if (id !== clientId || secret !== clientSecret) return json(401, { error: "invalid_client" });
      const grant = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      if (!grant || grant.challenge !== challenge || grant.redirectUri !== form.get("redirect_uri")) return json(400, { error: "invalid_grant" });
      const { identity } = grant;
      const idToken = await new SignJWT({ email: identity.email, email_verified: identity.email_verified ?? true, name: identity.name, nonce: grant.nonce })
        .setProtectedHeader({ alg: "RS256", kid: "test" })
        .setIssuer(issuer)
        .setAudience(clientId)
        .setSubject(identity.sub)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      return json(200, { access_token: "test-access-token", token_type: "Bearer", expires_in: 300, id_token: idToken });
    }
    json(404, { error: "not_found" });
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer,
    clientId,
    clientSecret,
    approve: async (authorizeUrl, identity) => approveParams(new URL(authorizeUrl).searchParams, identity),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
