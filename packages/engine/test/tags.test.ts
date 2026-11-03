import { describe, expect, it } from "vitest";
import { canonicalTags, MAX_TAG_LENGTH, MAX_TAGS_PER_TASK, normalizeTags, tagKey } from "../src/tags";

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
});
