import type { Db } from "@ganttlines/db";
import { tagKey } from "@ganttlines/engine";

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
  spellings.sort((a, b) => a.first.getTime() - b.first.getTime() || compareText(a.tag, b.tag));
  const byKey = new Map<string, { tag: string; uses: number }>();
  for (const { tag, uses } of spellings) {
    const key = tagKey(tag);
    const known = byKey.get(key);
    if (known) known.uses += uses;
    else byKey.set(key, { tag, uses });
  }
  return [...byKey.values()].sort((a, b) => b.uses - a.uses || compareText(a.tag, b.tag)).map(({ tag }) => tag);
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, "en", { sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);
}
