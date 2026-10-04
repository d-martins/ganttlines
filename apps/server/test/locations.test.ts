import { describe, expect, it } from "vitest";
import { setupAdmin, useTestApp } from "./helpers";

const t = useTestApp();

describe("locations", () => {
  async function team() {
    const admin = await setupAdmin(t.app);
    const post = (url: string, payload: object) => t.app.inject({ method: "POST", url, headers: { cookie: admin }, payload });
    const lisbon = (await post("/api/locations", { name: "Lisbon office", country: "PT" })).json().location;
    const munich = (await post("/api/locations", { name: "Munich office", country: "DE", region: "BY" })).json().location;
    const ana = (await post("/api/resources", { name: "Ana" })).json().resource;
    const rui = (await post("/api/resources", { name: "Rui" })).json().resource;
    await t.app.inject({ method: "PATCH", url: `/api/resources/${ana.id}`, headers: { cookie: admin }, payload: { locationId: lisbon.id } });
    const calendar = async () => (await t.app.inject({ url: "/api/calendar", headers: { cookie: admin } })).json();
    return { admin, post, lisbon, munich, ana, rui, calendar };
  }

  it("applies a location's holidays to whoever is in it — and follows people who move", async () => {
    const { admin, post, lisbon, munich, ana, rui, calendar } = await team();
    const holiday = (await post("/api/holidays", { name: "Santo António", startDate: "2026-06-13", endDate: "2026-06-13", appliesTo: [], locationIds: [lisbon.id] })).json().holiday;
    expect(holiday).toMatchObject({ appliesTo: [ana.id], target: { all: false, resourceIds: [], locationIds: [lisbon.id] } });
    expect((await calendar()).locations.map((location: { name: string }) => location.name)).toEqual(["Lisbon office", "Munich office"]);

    // Rui moves to Lisbon, Ana to Munich: the holiday now applies to Rui only.
    await t.app.inject({ method: "PATCH", url: `/api/resources/${rui.id}`, headers: { cookie: admin }, payload: { locationId: lisbon.id } });
    await t.app.inject({ method: "PATCH", url: `/api/resources/${ana.id}`, headers: { cookie: admin }, payload: { locationId: munich.id } });
    expect((await calendar()).holidays[0].appliesTo).toEqual([rui.id]);
  });

  it("suggests a country's (and region's) public holidays, and adds the chosen ones once", async () => {
    const { admin, post, lisbon, munich, ana, calendar } = await team();
    const suggested = (await t.app.inject({ url: `/api/locations/${lisbon.id}/public-holidays?year=2026`, headers: { cookie: admin } })).json().holidays;
    expect(suggested).toContainEqual({ name: "New Year's Day", startDate: "2026-01-01", endDate: "2026-01-01", type: "public", added: false });
    const bavaria = (await t.app.inject({ url: `/api/locations/${munich.id}/public-holidays?year=2026`, headers: { cookie: admin } })).json().holidays;
    expect(bavaria.map((holiday: { name: string }) => holiday.name)).toContain("Epiphany"); // regional (Bavaria)

    const picked = suggested.filter((holiday: { type: string }) => holiday.type === "public").slice(0, 3).map(({ name, startDate, endDate }: { name: string; startDate: string; endDate: string }) => ({ name, startDate, endDate }));
    expect((await post(`/api/locations/${lisbon.id}/holidays`, { holidays: picked })).json()).toEqual({ added: 3 });
    expect((await post(`/api/locations/${lisbon.id}/holidays`, { holidays: picked })).json()).toEqual({ added: 0 }); // already there
    const holidays = (await calendar()).holidays;
    expect(holidays).toHaveLength(3);
    expect(holidays.every((holiday: { appliesTo: string[] }) => holiday.appliesTo.join() === ana.id)).toBe(true);
    const again = (await t.app.inject({ url: `/api/locations/${lisbon.id}/public-holidays?year=2026`, headers: { cookie: admin } })).json().holidays;
    expect(again.filter((holiday: { added: boolean }) => holiday.added)).toHaveLength(3);
  });

  it("removing a location takes its own holidays with it and leaves shared ones", async () => {
    const { admin, post, lisbon, rui, ana, calendar } = await team();
    await post("/api/holidays", { name: "Lisbon only", startDate: "2026-06-13", endDate: "2026-06-13", appliesTo: [], locationIds: [lisbon.id] });
    await post("/api/holidays", { name: "Lisbon and Rui", startDate: "2026-06-24", endDate: "2026-06-24", appliesTo: [rui.id], locationIds: [lisbon.id] });
    expect((await t.app.inject({ method: "DELETE", url: `/api/locations/${lisbon.id}`, headers: { cookie: admin } })).statusCode).toBe(204);
    const after = await calendar();
    expect(after.holidays.map((holiday: { name: string; appliesTo: string[] }) => [holiday.name, holiday.appliesTo])).toEqual([["Lisbon and Rui", [rui.id]]]);
    expect((await t.app.inject({ url: "/api/resources", headers: { cookie: admin } })).json().resources.find((r: { id: string }) => r.id === ana.id).locationId).toBeNull();
  });

  it("checks countries, regions and who a holiday is for", async () => {
    const { post } = await team();
    expect((await post("/api/locations", { name: "Nowhere", country: "XX" })).statusCode).toBe(400);
    expect((await post("/api/locations", { name: "Odd", country: "DE", region: "ZZ" })).statusCode).toBe(400);
    expect((await post("/api/holidays", { name: "For nobody", startDate: "2026-06-13", endDate: "2026-06-13", appliesTo: [] })).statusCode).toBe(400);
    expect((await post("/api/holidays", { name: "Ghost", startDate: "2026-06-13", endDate: "2026-06-13", appliesTo: [], locationIds: ["00000000-0000-4000-8000-000000000000"] })).statusCode).toBe(400);
  });
});
