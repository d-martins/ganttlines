import { describe, expect, it } from "vitest";
import { HolidayBody, TimeOffBody, UpdateResourceBody, WorkingWeekdaysBody } from "../src/calendar";

const R = "11111111-1111-4111-8111-111111111111";

describe("calendar schemas", () => {
  it("accepts team-wide and targeted holidays", () => {
    expect(HolidayBody.safeParse({ name: "Carnival", startDate: "2027-02-09", endDate: "2027-02-09", appliesTo: "all" }).success).toBe(true);
    expect(HolidayBody.safeParse({ name: "Local", startDate: "2027-06-13", endDate: "2027-06-13", appliesTo: [R] }).success).toBe(true);
  });

  it("rejects reversed ranges and entries longer than a year", () => {
    expect(TimeOffBody.safeParse({ resourceId: R, startDate: "2026-10-09", endDate: "2026-10-05" }).success).toBe(false);
    expect(TimeOffBody.safeParse({ resourceId: R, startDate: "2026-01-01", endDate: "2027-01-02" }).success).toBe(false);
    expect(TimeOffBody.parse({ resourceId: R, startDate: "2026-01-01", endDate: "2027-01-01" }).note).toBe("");
  });

  it("validates working weekdays", () => {
    expect(WorkingWeekdaysBody.safeParse({ workingWeekdays: [1, 2, 3, 4, 5] }).success).toBe(true);
    for (const workingWeekdays of [[], [7], [1, 1], [1.5]]) {
      expect(WorkingWeekdaysBody.safeParse({ workingWeekdays }).success).toBe(false);
    }
  });

  it("validates resource colors and allows deactivation", () => {
    expect(UpdateResourceBody.safeParse({ inactive: true }).success).toBe(true);
    expect(UpdateResourceBody.safeParse({ avatarColor: "red" }).success).toBe(false);
  });
});
