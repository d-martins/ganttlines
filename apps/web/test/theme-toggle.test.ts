import { describe, expect, it } from "vitest";
import { nextTheme } from "../src/app/theme-toggle";

describe("the theme button", () => {
  it("from matching the system, goes to the look you don't have, so the first click always shows", () => {
    expect(nextTheme("system", false)).toBe("dark");
    expect(nextTheme("system", true)).toBe("light");
  });

  it("then the other, then back to matching the system", () => {
    expect(nextTheme("dark", false)).toBe("light");
    expect(nextTheme("light", false)).toBe("system");
    expect(nextTheme("light", true)).toBe("dark");
    expect(nextTheme("dark", true)).toBe("system");
  });
});
