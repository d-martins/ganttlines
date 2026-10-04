import type { User } from "@ganttlines/db";
import type { McpScope } from "@ganttlines/protocol";
import type { McpServer } from "@modelcontextprotocol/server";
import { HttpError } from "../errors";
import type { RouteContext } from "../routes/context";
import { ToolProblem } from "./lookup";

/** Who is calling: the person, the app they connected, and the groups this call may use. */
export interface McpCaller {
  user: User;
  app: string;
  connectionId: string;
  scopes: McpScope[];
}

export interface ToolContext {
  context: RouteContext;
  caller: McpCaller;
}

/** What a tool answers: a one-line summary and the data (also as JSON text, which every app reads). */
export function answer(summary: string, data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: `${summary}\n\n${JSON.stringify(data)}` }],
    structuredContent: data,
  };
}

/** Runs a tool, turning problems the AI can fix (and our usual errors) into tool errors it can read. */
export async function guarded<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ToolProblem || error instanceof HttpError) {
      return { content: [{ type: "text" as const, text: error.message }], isError: true };
    }
    throw error;
  }
}

export type ToolGroup = (server: McpServer, tools: ToolContext) => void;
