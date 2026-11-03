import type { Db } from "@ganttlines/db";
import { rankTags } from "@ganttlines/engine";

/**
 * Every tag used on a task anywhere in the workspace, one spelling per tag: the spelling found
 * first (oldest project first), most used first, then alphabetically. One query.
 */
export async function workspaceTags(db: Db): Promise<string[]> {
  const spellings = await db.$queryRaw<{ tag: string; uses: number; first: Date }[]>`
    SELECT t.tag, count(*)::int AS uses, min(p."createdAt") AS first
    FROM "Row" r
    JOIN "Project" p ON p."id" = r."projectId"
    CROSS JOIN LATERAL unnest(r."tags") AS t(tag)
    WHERE r."kind" = 'task'
    GROUP BY t.tag`;
  return rankTags(spellings.map(({ tag, uses, first }) => ({ tag, uses, first: first.getTime() })));
}
