import type { User } from "@ganttlines/db";

/** Who performed a command, as recorded in the command log. */
export interface Actor {
  userId: string | null;
  label: string;
}

export function actorOf(user: User): Actor {
  return { userId: user.id, label: user.name };
}
