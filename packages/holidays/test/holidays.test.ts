import { describe, expect, it } from "vitest";
import { countries, publicHolidays, regions } from "../src";

describe("public holidays", () => {
  it("lists countries and their regions, sorted by name", () => {
    const all = countries();
    expect(all).toContainEqual({ code: "PT", name: "Portugal" });
    expect(all.map((country) => country.name)).toEqual([...all.map((country) => country.name)].sort((a, b) => a.localeCompare(b)));
    expect(regions("DE").length).toBeGreaterThan(10);
  });

  it("gives a year's holidays with ISO dates, once each", () => {
    const holidays = publicHolidays("PT", null, 2026);
    expect(holidays).toContainEqual(expect.objectContaining({ startDate: "2026-12-25", endDate: "2026-12-25", type: "public" }));
    const keys = holidays.map((holiday) => `${holiday.name}|${holiday.startDate}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
