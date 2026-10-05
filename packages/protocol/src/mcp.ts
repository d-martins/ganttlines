import { z } from "zod";
import { MCP_SCOPES, MCP_WRITE_SCOPES, MCP_SCOPE_LABELS, type McpScope } from "./constants";

export { MCP_SCOPES, MCP_WRITE_SCOPES, MCP_SCOPE_LABELS, type McpScope };


/** GET/PUT /api/settings/mcp (admins) */
export interface McpSettingsDto {
  enabled: boolean;
  scopes: McpScope[];
  /** the URL to give AI apps */
  url: string;
}
export const McpSettingsBody = z.strictObject({ enabled: z.boolean(), scopes: z.array(z.enum(MCP_SCOPES)).max(MCP_SCOPES.length) });
export type McpSettingsBody = z.infer<typeof McpSettingsBody>;

/** A person's approval for one AI app, or a personal access token they made. */
export interface McpConnectionDto {
  id: string;
  /** the app's name, or the token's */
  app: string;
  kind: "app" | "token";
  /** when a token stops working (null: never); absent for apps */
  expiresAt?: string | null;
  scopes: McpScope[];
  createdAt: string;
  lastUsedAt: string | null;
  /** whose connection it is (in the admins' list of everyone's) */
  user?: { id: string; name: string; email: string };
}

/** GET /api/oauth/request?request=… — what the "Allow access?" page shows. */
export interface OAuthRequestDto {
  app: { name: string; redirectHost: string };
  /** every group, and whether it can be granted (allowed by the admin and the person's role) and was asked for */
  scopes: { scope: McpScope; grantable: boolean; requested: boolean }[];
}

/** POST /api/oauth/consent */
export const OAuthConsentBody = z.strictObject({
  request: z.string().min(1).max(4096),
  approve: z.boolean(),
  scopes: z.array(z.enum(MCP_SCOPES)).max(MCP_SCOPES.length),
});
export type OAuthConsentBody = z.infer<typeof OAuthConsentBody>;

/** POST /api/mcp/tokens — a personal access token, for AI apps that don't sign in with OAuth. */
export const CreateMcpTokenBody = z.strictObject({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(MCP_SCOPES)).min(1).max(MCP_SCOPES.length),
  /** days until it stops working; null: never */
  expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365), z.null()]),
});
export type CreateMcpTokenBody = z.infer<typeof CreateMcpTokenBody>;
