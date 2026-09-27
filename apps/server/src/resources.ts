import type { Db, Prisma } from "@ganttlines/db";

export const AVATAR_COLORS = ["#4f8cff", "#a66cff", "#ff6fae", "#ff8a4c", "#2fbf71", "#1fb5c9", "#f5b82e", "#8a94a6"];

/** Creates the team member (resource) that represents a user on the board. */
export async function createLinkedResource(db: Db | Prisma.TransactionClient, userId: string, name: string): Promise<void> {
  const count = await db.resource.count();
  await db.resource.create({ data: { name, userId, avatarColor: AVATAR_COLORS[count % AVATAR_COLORS.length]! } });
}
