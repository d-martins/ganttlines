export const MAX_TAGS_PER_TASK = 50;
export const MAX_TAG_LENGTH = 100;

/** Tags that differ only by case or surrounding spaces are the same tag. */
export const tagKey = (tag: string): string => tag.trim().toLowerCase();

/** Trims, drops empty tags and later spellings of the same tag (the first is kept). Throws `RangeError` past the limits. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag === "") continue;
    if (tag.length > MAX_TAG_LENGTH) throw new RangeError(`Tags are at most ${MAX_TAG_LENGTH} characters`);
    const key = tagKey(tag);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  if (result.length > MAX_TAGS_PER_TASK) throw new RangeError(`A task has at most ${MAX_TAGS_PER_TASK} tags`);
  return result;
}

/** Each tag respelled as the `known` tag with the same key, when there is one. */
export function canonicalTags(tags: readonly string[], known: readonly string[]): string[] {
  const spelling = new Map<string, string>();
  for (const tag of known) if (!spelling.has(tagKey(tag))) spelling.set(tagKey(tag), tag);
  return tags.map((tag) => spelling.get(tagKey(tag)) ?? tag);
}

/** One exact spelling of a tag: on how many tasks it is, and when the oldest project using it was made (ms). */
export interface TagUse {
  tag: string;
  uses: number;
  first: number;
}

/**
 * A workspace's tag list from the spellings in use: one spelling per tag — the one found first
 * (oldest project first, then alphabetically) — most used first, then alphabetically.
 */
export function rankTags(spellings: readonly TagUse[]): string[] {
  const ordered = [...spellings].sort((a, b) => a.first - b.first || compareText(a.tag, b.tag));
  const byKey = new Map<string, { tag: string; uses: number }>();
  for (const { tag, uses } of ordered) {
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
