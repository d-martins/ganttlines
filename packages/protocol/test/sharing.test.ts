import { describe, expect, it } from "vitest";
import { CreateShareLinkBody, UpdateShareLinkBody, VisitorBody } from "../src/sharing";

describe("sharing schemas", () => {
  it("defaults new links to view-only with no label", () => {
    expect(CreateShareLinkBody.parse({ access: "anonymous" })).toEqual({ access: "anonymous", collaboration: false, label: "" });
    expect(CreateShareLinkBody.safeParse({ access: "public" }).success).toBe(false);
  });

  it("validates updates and visitor names", () => {
    expect(UpdateShareLinkBody.safeParse({ collaboration: true }).success).toBe(true);
    expect(UpdateShareLinkBody.safeParse({ access: "anonymous" }).success).toBe(false);
    expect(VisitorBody.parse({ name: "  Rudy " }).name).toBe("Rudy");
    expect(VisitorBody.safeParse({ name: "" }).success).toBe(false);
  });
});
