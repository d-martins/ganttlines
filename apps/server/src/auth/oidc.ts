import { createHmac, timingSafeEqual } from "node:crypto";
import * as client from "openid-client";

/** OpenID Connect sign-in (Google, Microsoft, Keycloak, Authentik …), from the OIDC_* settings. */
export interface OidcSettings {
  issuer: URL;
  clientId: string;
  clientSecret: string;
  /** shown on the button: "Sign in with <name>" */
  name: string;
  scopes: string;
  /** email domains allowed to sign in (empty: any) */
  allowedDomains: string[];
  /** create an account for unknown people (otherwise an admin adds them first) */
  autoCreate: boolean;
  /** the role of accounts created that way */
  defaultRole: "admin" | "editor" | "viewer" | "guest";
}

/** What the provider vouches for. */
export interface OidcIdentity {
  /** stable account key: issuer + subject */
  subject: string;
  email: string;
  name: string;
}

export type OidcFailure = "sso_failed" | "sso_unverified" | "sso_domain";

export class OidcError extends Error {
  constructor(
    readonly code: OidcFailure,
    message: string,
  ) {
    super(message);
  }
}

/** The round trip's secrets, kept in a short-lived signed cookie between start and callback. */
interface Pending {
  state: string;
  nonce: string;
  verifier: string;
  redirect: string;
  expires: number;
}

const PENDING_FOR_MS = 10 * 60 * 1000;

export class OidcSignIn {
  private configuration: Promise<client.Configuration> | null = null;

  constructor(
    readonly settings: OidcSettings,
    private readonly callbackUrl: string,
    private readonly secret: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** The provider's settings (discovered once; retried after a failure). */
  private config(): Promise<client.Configuration> {
    this.configuration ??= client
      .discovery(this.settings.issuer, this.settings.clientId, this.settings.clientSecret, undefined, {
        // Plain http only for a provider on this machine (local testing).
        ...(this.settings.issuer.protocol === "http:" ? { execute: [client.allowInsecureRequests] } : {}),
      })
      .catch((error: unknown) => {
        this.configuration = null;
        throw error;
      });
    return this.configuration;
  }

  /** Where to send the browser, and the cookie value that proves the answer is for this attempt. */
  async start(redirect: string): Promise<{ url: string; cookie: string }> {
    const config = await this.config();
    const pending: Pending = {
      state: client.randomState(),
      nonce: client.randomNonce(),
      verifier: client.randomPKCECodeVerifier(),
      redirect,
      expires: this.now() + PENDING_FOR_MS,
    };
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.callbackUrl,
      scope: this.settings.scopes,
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: await client.calculatePKCECodeChallenge(pending.verifier),
      code_challenge_method: "S256",
    });
    return { url: url.toString(), cookie: this.sign(pending) };
  }

  /** Checks the provider's answer (state, nonce, PKCE, ID token) and returns who signed in, and where to go. */
  async finish(currentUrl: URL, cookie: string | undefined): Promise<{ identity: OidcIdentity; redirect: string }> {
    const pending = cookie ? this.verify(cookie) : null;
    if (!pending || pending.expires < this.now()) throw new OidcError("sso_failed", "The sign-in took too long or was started elsewhere — try again");
    let claims: client.IDToken | undefined;
    try {
      const tokens = await client.authorizationCodeGrant(await this.config(), currentUrl, {
        pkceCodeVerifier: pending.verifier,
        expectedState: pending.state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      });
      claims = tokens.claims();
    } catch (error) {
      throw new OidcError("sso_failed", `The provider's answer couldn't be checked: ${(error as Error).message}`);
    }
    const email = typeof claims?.["email"] === "string" ? claims["email"].toLowerCase() : null;
    // Only a verified email can be trusted to match (or create) an account.
    if (!claims || !email || claims["email_verified"] !== true) throw new OidcError("sso_unverified", "The provider didn't confirm your email address");
    const domain = email.split("@")[1] ?? "";
    if (this.settings.allowedDomains.length > 0 && !this.settings.allowedDomains.includes(domain)) {
      throw new OidcError("sso_domain", `${domain} accounts can't sign in here`);
    }
    const name = typeof claims["name"] === "string" && claims["name"].trim() ? claims["name"].trim().slice(0, 100) : email.split("@")[0]!;
    return { identity: { subject: `${claims.iss}#${claims.sub}`, email, name }, redirect: pending.redirect };
  }

  private sign(pending: Pending): string {
    const body = Buffer.from(JSON.stringify(pending)).toString("base64url");
    return `${body}.${this.mac(body)}`;
  }

  private verify(cookie: string): Pending | null {
    const [body, mac] = cookie.split(".");
    if (!body || !mac) return null;
    const expected = Buffer.from(this.mac(body));
    const given = Buffer.from(mac);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      return JSON.parse(Buffer.from(body, "base64url").toString()) as Pending;
    } catch {
      return null;
    }
  }

  private mac(body: string): string {
    return createHmac("sha256", `oidc:${this.secret}`).update(body).digest("base64url");
  }
}

/** OIDC_* settings: off unless issuer, client id and secret are all set. */
export function oidcSettings(env: NodeJS.ProcessEnv): OidcSettings | null {
  const [issuer, clientId, clientSecret] = [env["OIDC_ISSUER"], env["OIDC_CLIENT_ID"], env["OIDC_CLIENT_SECRET"]];
  if (!issuer && !clientId && !clientSecret) return null;
  if (!issuer || !clientId || !clientSecret) throw new Error("Set OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET together (or none)");
  const role = env["OIDC_DEFAULT_ROLE"] || "viewer";
  if (!["admin", "editor", "viewer", "guest"].includes(role)) throw new Error(`Invalid OIDC_DEFAULT_ROLE: ${role}`);
  return {
    issuer: new URL(issuer),
    clientId,
    clientSecret,
    name: env["OIDC_NAME"] || "single sign-on",
    scopes: env["OIDC_SCOPES"] || "openid email profile",
    allowedDomains: (env["OIDC_ALLOWED_DOMAINS"] ?? "")
      .split(",")
      .map((domain) => domain.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean),
    autoCreate: env["OIDC_AUTO_CREATE"] === "true",
    defaultRole: role as OidcSettings["defaultRole"],
  };
}
