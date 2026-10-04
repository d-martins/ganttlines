import type { Db } from "@ganttlines/db";
import { MCP_SCOPES, type McpScope } from "@ganttlines/protocol";

const DEFAULT_SCOPES: McpScope[] = ["plans:read", "plans:write", "comments", "team:read"];

/** The admins' switch for AI access, and the tool groups (scopes) the server allows. */
export class McpSettings {
  constructor(private readonly db: Db) {}

  async read(): Promise<{ enabled: boolean; scopes: McpScope[] }> {
    const settings = await this.db.settings.findUnique({ where: { id: 1 }, select: { mcpEnabled: true, mcpScopes: true } });
    const stored = settings?.mcpScopes ?? DEFAULT_SCOPES;
    return { enabled: settings?.mcpEnabled ?? false, scopes: MCP_SCOPES.filter((scope) => stored.includes(scope)) };
  }

  async write(enabled: boolean, scopes: McpScope[]): Promise<void> {
    const data = { mcpEnabled: enabled, mcpScopes: MCP_SCOPES.filter((scope) => scopes.includes(scope)) };
    await this.db.settings.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
  }
}
