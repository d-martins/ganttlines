/**
 * Plain values shared by the server and the web app, without zod — so the web app can import them
 * (`@ganttlines/protocol/constants`) without bundling the request schemas.
 */

export const ROLES = ["admin", "editor", "viewer", "guest"] as const;
export type Role = (typeof ROLES)[number];

/** Who must use two-factor to sign in with a password (single sign-on relies on the provider's). */
export const TWO_FACTOR_REQUIREMENTS = ["off", "admins", "everyone"] as const;
export type TwoFactorRequirement = (typeof TWO_FACTOR_REQUIREMENTS)[number];

export const BOARD_LIMITS = { commentMax: 10_000, commentsPerTask: 1000, highlightLabelMax: 100, baselineNameMax: 100, activityPageMax: 100, commentPageMax: 100 } as const;

export const COMMAND_LIMITS = {
  titleMax: 500,
  descriptionMax: 20_000,
  deleteRowsMax: 5_000,
} as const;

export const SHARE_TOKEN_HEADER = "x-share-token";

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
