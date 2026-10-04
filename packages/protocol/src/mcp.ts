import { z } from "zod";

/**
 * What AI apps connected over MCP may do, one OAuth scope per tool group. Admins choose which the
 * server allows; people grant some of those to each app; roles still apply (viewers only read).
 */
export const MCP_SCOPES = ["plans:read", "plans:write", "comments", "team:read", "team:write"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/** Groups that change things: only editors and admins can grant them. */
export const MCP_WRITE_SCOPES: readonly McpScope[] = ["plans:write", "team:write"];

export const MCP_SCOPE_LABELS: Record<McpScope, { label: string; detail: string }> = {
  "plans:read": { label: "Read plans", detail: "Projects, tasks, dates and history" },
  "plans:write": { label: "Edit plans", detail: "Create projects; add, change, move and delete tasks" },
  comments: { label: "Comments", detail: "Read and add comments" },
  "team:read": { label: "Team calendar", detail: "Team members, locations, holidays and time off" },
  "team:write": { label: "Edit the team calendar", detail: "Change team members, locations, holidays and time off" },
};

/** GET/PUT /api/settings/mcp (admins) */
export interface McpSettingsDto {
  enabled: boolean;
  scopes: McpScope[];
  /** the URL to give AI apps */
  url: string;
}
export const McpSettingsBody = z.strictObject({ enabled: z.boolean(), scopes: z.array(z.enum(MCP_SCOPES)).max(MCP_SCOPES.length) });
export type McpSettingsBody = z.infer<typeof McpSettingsBody>;

/** A person's approval for one AI app. */
export interface McpConnectionDto {
  id: string;
  app: string;
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
