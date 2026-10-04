import type { Db, McpConnection, User } from "@ganttlines/db";
import { MCP_SCOPES, MCP_WRITE_SCOPES, type McpScope, type Role } from "@ganttlines/protocol";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { OAuthFailure } from "./clients";

const CODE_FOR_MS = 10 * 60 * 1000;
export const ACCESS_FOR_MS = 60 * 60 * 1000;
/** Refresh tokens last this long without being used; each use replaces it. */
const REFRESH_FOR_MS = 90 * 24 * 60 * 60 * 1000;
/** Personal access tokens that "never" expire stop working this far away. */
export const NEVER_EXPIRES = new Date("9999-12-31T00:00:00Z");
/** How long an authorization request may wait on the "Allow access?" page. */
const REQUEST_FOR_MS = 15 * 60 * 1000;

/** A validated authorization request, carried (signed) to the "Allow access?" page and back. */
export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scopes: McpScope[];
}

/** The groups a role can grant: viewers only read. */
export function scopesForRole(role: Role): McpScope[] {
  if (role === "guest") return [];
  return MCP_SCOPES.filter((scope) => role === "editor" || role === "admin" || !MCP_WRITE_SCOPES.includes(scope));
}

export function parseScopes(value: unknown): McpScope[] {
  if (typeof value !== "string") return [];
  const words = new Set(value.split(" "));
  return MCP_SCOPES.filter((scope) => words.has(scope));
}

export interface IssuedTokens {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** Signed requests, one-time codes, and access/refresh tokens (only their HMACs are stored). */
export class OAuthGrants {
  private readonly key: Buffer;

  constructor(
    private readonly db: Db,
    secret: string,
    private readonly now: () => Date,
  ) {
    this.key = createHash("sha256").update(`oauth:${secret}`).digest();
  }

  signRequest(request: AuthorizationRequest): string {
    const body = Buffer.from(JSON.stringify({ ...request, e: this.now().getTime() + REQUEST_FOR_MS })).toString("base64url");
    return `${body}.${this.mac(`request:${body}`)}`;
  }

  readRequest(signed: string): AuthorizationRequest | null {
    const [body, mac] = signed.split(".");
    if (!body || !mac) return null;
    const [given, expected] = [Buffer.from(mac), Buffer.from(this.mac(`request:${body}`))];
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const { e, ...request } = JSON.parse(Buffer.from(body, "base64url").toString()) as AuthorizationRequest & { e: number };
      return e > this.now().getTime() ? request : null;
    } catch {
      return null;
    }
  }

  /** Records the person's approval (or updates it: approving the same app again replaces its groups). */
  async approve(userId: string, clientId: string, scopes: McpScope[]): Promise<McpConnection> {
    return this.db.mcpConnection.upsert({
      where: { userId_clientId: { userId, clientId } },
      create: { userId, clientId, scopes },
      update: { scopes },
    });
  }

  async issueCode(connectionId: string, request: AuthorizationRequest, scopes: McpScope[]): Promise<string> {
    const code = randomBytes(32).toString("base64url");
    await this.db.oAuthCode.create({
      data: {
        id: this.digest(code),
        connectionId,
        scopes,
        codeChallenge: request.codeChallenge,
        redirectUri: request.redirectUri,
        expiresAt: new Date(this.now().getTime() + CODE_FOR_MS),
      },
    });
    return code;
  }

  /** Authorization code + PKCE verifier → tokens. Codes work once. */
  async exchangeCode(input: { code: string; clientId: string; redirectUri: string; verifier: string }): Promise<IssuedTokens> {
    const id = this.digest(input.code);
    const code = await this.db.oAuthCode.findUnique({ where: { id }, include: { connection: true } });
    if (code) await this.db.oAuthCode.deleteMany({ where: { id } });
    if (!code || code.expiresAt <= this.now() || code.connection.clientId !== input.clientId || code.redirectUri !== input.redirectUri) {
      throw new OAuthFailure("invalid_grant", "The authorization code is invalid or expired");
    }
    const challenge = createHash("sha256").update(input.verifier).digest("base64url");
    if (challenge !== code.codeChallenge) throw new OAuthFailure("invalid_grant", "The code verifier doesn't match");
    return this.issueTokens(code.connectionId, code.scopes as McpScope[]);
  }

  /**
   * A refresh token → a new pair; the old one is spent. Presenting a spent one again means it was
   * copied: every token of that connection stops working.
   */
  async refresh(input: { refreshToken: string; clientId: string }): Promise<IssuedTokens> {
    const id = this.digest(input.refreshToken);
    const token = await this.db.oAuthToken.findUnique({ where: { id }, include: { connection: true } });
    if (!token || token.kind !== "refresh" || token.connection.clientId !== input.clientId) {
      throw new OAuthFailure("invalid_grant", "The refresh token is invalid");
    }
    if (token.rotatedAt) {
      await this.db.oAuthToken.deleteMany({ where: { connectionId: token.connectionId } });
      throw new OAuthFailure("invalid_grant", "The refresh token was already used");
    }
    if (token.expiresAt <= this.now()) throw new OAuthFailure("invalid_grant", "The refresh token expired");
    const { count } = await this.db.oAuthToken.updateMany({ where: { id, rotatedAt: null }, data: { rotatedAt: this.now() } });
    if (count === 0) throw new OAuthFailure("invalid_grant", "The refresh token was already used");
    // The person may have narrowed the app's groups since.
    const scopes = (token.scopes as McpScope[]).filter((scope) => token.connection.scopes.includes(scope));
    return this.issueTokens(token.connectionId, scopes);
  }

  /** RFC 7009: forgets the token, whichever kind it is; unknown tokens are fine. */
  async revoke(token: string): Promise<void> {
    await this.db.oAuthToken.deleteMany({ where: { id: this.digest(token) } });
  }

  /** The connection, app name and person behind a live access token (or personal access token), or null. */
  async verifyAccess(token: string): Promise<{ connection: McpConnection; app: string; user: User; scopes: McpScope[]; expiresAt: Date } | null> {
    const found = await this.db.oAuthToken.findUnique({
      where: { id: this.digest(token) },
      include: { connection: { include: { user: true, client: { select: { name: true } } } } },
    });
    if (!found || found.kind === "refresh" || found.expiresAt <= this.now()) return null;
    const { user, client, ...connection } = found.connection;
    const scopes = (found.scopes as McpScope[]).filter((scope) => connection.scopes.includes(scope));
    return { connection, app: client?.name ?? connection.label ?? "Access token", user, scopes, expiresAt: found.expiresAt };
  }

  /**
   * A personal access token: a connection of its own (no app), shown to its maker once. It starts
   * with "gl_pat_" so people (and secret scanners) can tell what it is.
   */
  async createPersonalToken(
    userId: string,
    label: string,
    scopes: McpScope[],
    expiresInDays: number | null,
  ): Promise<{ token: string; connection: McpConnection; expiresAt: Date }> {
    const token = `gl_pat_${randomBytes(32).toString("base64url")}`;
    const expiresAt = expiresInDays === null ? NEVER_EXPIRES : new Date(this.now().getTime() + expiresInDays * 24 * 60 * 60 * 1000);
    const connection = await this.db.mcpConnection.create({
      data: { userId, label, scopes, tokens: { create: { id: this.digest(token), kind: "personal", scopes, expiresAt } } },
    });
    return { token, connection, expiresAt };
  }

  /** Notes when an app last used its connection (at most once a minute). */
  async touch(connection: McpConnection): Promise<void> {
    const now = this.now();
    if (connection.lastUsedAt && now.getTime() - connection.lastUsedAt.getTime() < 60_000) return;
    await this.db.mcpConnection.updateMany({ where: { id: connection.id }, data: { lastUsedAt: now } });
  }

  /** Codes and tokens past their expiry (and personal access tokens' connections with them). */
  async deleteExpired(): Promise<void> {
    const now = this.now();
    await this.db.oAuthCode.deleteMany({ where: { expiresAt: { lte: now } } });
    await this.db.oAuthToken.deleteMany({ where: { expiresAt: { lte: now } } });
    await this.db.mcpConnection.deleteMany({ where: { clientId: null, tokens: { none: {} } } });
  }

  private async issueTokens(connectionId: string, scopes: McpScope[]): Promise<IssuedTokens> {
    const [access, refresh] = [randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")];
    const now = this.now().getTime();
    await this.db.oAuthToken.createMany({
      data: [
        { id: this.digest(access), connectionId, kind: "access", scopes, expiresAt: new Date(now + ACCESS_FOR_MS) },
        { id: this.digest(refresh), connectionId, kind: "refresh", scopes, expiresAt: new Date(now + REFRESH_FOR_MS) },
      ],
    });
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_FOR_MS / 1000, refresh_token: refresh, scope: scopes.join(" ") };
  }

  private digest(token: string): string {
    return this.mac(`token:${token}`);
  }

  private mac(value: string): string {
    return createHmac("sha256", this.key).update(value).digest("base64url");
  }
}
