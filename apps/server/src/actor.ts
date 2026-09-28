import type { User } from "@ganttlines/db";

/** Who performed a command, as recorded in the command log. */
export interface Actor {
  userId: string | null;
  label: string;
  /** anonymous share-link visitors have no user, but a stable id (from their signed cookie) */
  visitorId?: string | null;
}

export function actorOf(user: User): Actor {
  return { userId: user.id, label: user.name };
}

/** Stable identity used for undo history and presence: the user, or the anonymous visitor. */
export function actorKey(actor: Actor): string | null {
  if (actor.userId) return `user:${actor.userId}`;
  if (actor.visitorId) return `visitor:${actor.visitorId}`;
  return null;
}
