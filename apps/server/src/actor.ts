import type { User } from "@ganttlines/db";

/** Who performed a command, as recorded in the command log. */
export interface Actor {
  userId: string | null;
  label: string;
  /** anonymous share-link visitors have no user, but a stable id (from their signed cookie) */
  visitorId?: string | null;
  /** the share link the action came through, if any */
  linkId?: string | null;
  /** the AI app connection the action came through (MCP), if any */
  connectionId?: string | null;
}

export function actorOf(user: User): Actor {
  return { userId: user.id, label: user.name };
}

/** A person acting through an AI app they connected: "Ana via Claude". */
export function aiActorOf(user: User, app: string, connectionId: string): Actor {
  return { userId: user.id, label: `${user.name} via ${app}`, connectionId };
}

/**
 * Stable identity used for undo history and presence: the user, or the anonymous visitor. An AI
 * app gets its own (so the person's own undo never reverts what their AI did, and vice versa).
 */
export function actorKey(actor: Actor): string | null {
  if (actor.connectionId) return `mcp:${actor.connectionId}`;
  if (actor.userId) return `user:${actor.userId}`;
  if (actor.visitorId) return `visitor:${actor.visitorId}`;
  return null;
}
