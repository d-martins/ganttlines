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
