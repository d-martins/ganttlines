import { describe, expect, it } from "vitest";
import { CommentBody, CreateBaselineBody, HighlightBody } from "../src/board";

const TASK = "11111111-1111-4111-8111-111111111111";

describe("board schemas", () => {
  it("validates comments", () => {
    expect(CommentBody.parse({ taskId: TASK, body: "  Looks good  " }).body).toBe("Looks good");
    expect(CommentBody.safeParse({ taskId: TASK, body: "   " }).success).toBe(false);
    expect(CommentBody.safeParse({ taskId: TASK, body: "x".repeat(10_001) }).success).toBe(false);
  });

  it("validates highlights and baselines", () => {
    expect(HighlightBody.parse({ date: "2026-10-05", color: "#ff0000" }).label).toBe("");
    expect(HighlightBody.safeParse({ date: "2026-13-01", color: "#ff0000" }).success).toBe(false);
    expect(CreateBaselineBody.safeParse({ name: "" }).success).toBe(false);
  });
});
