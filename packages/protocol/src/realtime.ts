import type { RowChange } from "@ganttlines/engine";
import { z } from "zod";
import type { ProjectDto } from "./api";
import { CommandSchema } from "./commands";

const id = z.uuid();

/**
 * Messages a browser sends over the WebSocket (`/ws`). A connection shows one project at a time:
 * `join` switches to it and catches up from `version`; commands and undo/redo apply to the joined project.
 */
export const ClientMessage = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("join"), projectId: id, version: z.int().min(0) }),
  z.strictObject({ type: z.literal("leave") }),
  z.strictObject({ type: z.literal("command"), commandId: id, command: CommandSchema }),
  z.strictObject({ type: z.literal("undo"), commandId: id }),
  z.strictObject({ type: z.literal("redo"), commandId: id }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Someone looking at a project: `id` is stable per person (user or anonymous visitor). */
export interface Viewer {
  id: string;
  name: string;
}

/**
 * Messages the server sends. Patch ordering rules for clients:
 * - apply a patch only when its version is exactly the local version + 1;
 * - ignore patches whose version is ≤ the local version (catch-up and live patches can overlap);
 * - before `joined` (or while reloading `/state` after `reload`), hold patches that leave a gap;
 * - after `joined`, a gap means something was missed: join again with the local version.
 * Close code 4001 means the session ended or access changed (sign in again); 1008 means flooding.
 */
export type ServerMessage =
  | { type: "joined"; projectId: string; version: number; instanceVersion: number; viewers: Viewer[] }
  | { type: "reload"; projectId: string }
  | { type: "patch"; projectId: string; version: number; commandId: string; actor: { userId: string | null; label: string }; changes: RowChange[] }
  | { type: "ack"; commandId: string; version: number; skipped?: number }
  | { type: "reject"; commandId: string; error: string; message: string }
  | { type: "presence"; projectId: string; viewers: Viewer[] }
  | { type: "project"; project: ProjectDto }
  | { type: "instance"; version: number }
  | { type: "error"; message: string };
