import { describe, expect, it } from "vitest";
import { canonicalTags, MAX_TAG_LENGTH, MAX_TAGS_PER_TASK, normalizeTags, rankTags, tagKey } from "../src/tags";

describe("tags", () => {
  it("keys ignore case and surrounding spaces", () => {
    expect(tagKey("  UI ")).toBe("ui");
  });

  it("normalizes: trims, drops empties and case-insensitive duplicates", () => {
    expect(normalizeTags(["  UI ", "ui", "", "Q4 · must-have"])).toEqual(["UI", "Q4 · must-have"]);
  });

  it("enforces the limits", () => {
    expect(() => normalizeTags(Array.from({ length: MAX_TAGS_PER_TASK + 1 }, (_, i) => `t${i}`))).toThrow(RangeError);
    expect(normalizeTags(Array.from({ length: MAX_TAGS_PER_TASK }, (_, i) => `t${i}`))).toHaveLength(MAX_TAGS_PER_TASK);
    expect(() => normalizeTags(["x".repeat(MAX_TAG_LENGTH + 1)])).toThrow(RangeError);
    expect(normalizeTags(["x".repeat(MAX_TAG_LENGTH)])).toHaveLength(1);
  });

  it("resolves to the known spelling", () => {
    expect(canonicalTags(["ui", "New"], ["UI"])).toEqual(["UI", "New"]);
  });

  it("ranks a workspace's tags: one spelling each (the oldest project's), most used first, then alphabetically", () => {
    const launch = 1_000;
    const other = 2_000;
    expect(
      rankTags([
        { tag: "UI", uses: 2, first: launch },
        { tag: "Back end", uses: 1, first: launch },
        { tag: "Zeta", uses: 1, first: launch },
        { tag: "alpha", uses: 1, first: other },
        { tag: "ui", uses: 1, first: other },
      ]),
    ).toEqual(["UI", "alpha", "Back end", "Zeta"]);
    expect(rankTags([])).toEqual([]);
  });

  it("ranks spellings found in the same project alphabetically, and merges their uses", () => {
    expect(rankTags([{ tag: "ui", uses: 1, first: 5 }, { tag: "UI", uses: 1, first: 5 }, { tag: "Docs", uses: 1, first: 5 }])).toEqual(["UI", "Docs"]);
  });
});
