import { describe, expect, it } from "vitest";
import { fromDay, toDay, weekday } from "../src/date";

describe("date", () => {
  it("maps the epoch to day 0 and back", () => {
    expect(toDay("1970-01-01")).toBe(0);
    expect(fromDay(0)).toBe("1970-01-01");
  });

  it("round-trips arbitrary dates", () => {
    expect(fromDay(toDay("2026-09-27"))).toBe("2026-09-27");
    expect(toDay("2026-10-01") - toDay("2026-09-27")).toBe(4);
  });

  it("computes weekdays (0 = Sunday)", () => {
    expect(weekday(toDay("1970-01-01"))).toBe(4);
    expect(weekday(toDay("2026-09-27"))).toBe(0);
    expect(weekday(toDay("2026-10-03"))).toBe(6);
  });

  it("rejects malformed and impossible dates", () => {
    expect(() => toDay("2026-02-30")).toThrow(RangeError);
    expect(() => toDay("27/09/2026")).toThrow(RangeError);
  });

  it("accepts leap days only in leap years", () => {
    expect(fromDay(toDay("2024-02-29"))).toBe("2024-02-29");
    expect(() => toDay("2025-02-29")).toThrow(RangeError);
  });
});
