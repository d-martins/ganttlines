import { describe, expect, it } from "vitest";
import { createUser, setupAdmin, useTestApp } from "./helpers";

const t = useTestApp();

async function asEditor() {
  const admin = await setupAdmin(t.app);
  const editor = await createUser(t.app, admin, { email: "ed@example.com", name: "Ed", role: "editor" });
  return { admin, editor: editor.cookie };
}

describe("team members (resources)", () => {
  it("lists members created with users and lets editors add plain members", async () => {
    const { editor } = await asEditor();
    const created = await t.app.inject({ method: "POST", url: "/api/resources", headers: { cookie: editor }, payload: { name: "Ana" } });
    expect(created.statusCode).toBe(201);
    expect(created.json().resource).toMatchObject({ name: "Ana", inactive: false, userId: null });
    const list = (await t.app.inject({ url: "/api/resources", headers: { cookie: editor } })).json().resources;
    expect(list.map((r: { name: string }) => r.name)).toEqual(["Admin", "Ed", "Ana"]);
  });

  it("renames, recolors and deactivates members", async () => {
    const { editor } = await asEditor();
    const ana = (await t.app.inject({ method: "POST", url: "/api/resources", headers: { cookie: editor }, payload: { name: "Ana" } })).json().resource;
    const updated = await t.app.inject({
      method: "PATCH",
      url: `/api/resources/${ana.id}`,
      headers: { cookie: editor },
      payload: { name: "Ana M.", avatarColor: "#123abc", inactive: true },
    });
    expect(updated.json().resource).toMatchObject({ name: "Ana M.", avatarColor: "#123abc", inactive: true });
  });

  it("does not let viewers change members", async () => {
    const admin = await setupAdmin(t.app);
    const viewer = await createUser(t.app, admin, { email: "v@example.com", name: "Vi", role: "viewer" });
    expect((await t.app.inject({ url: "/api/resources", headers: { cookie: viewer.cookie } })).statusCode).toBe(200);
    const post = await t.app.inject({ method: "POST", url: "/api/resources", headers: { cookie: viewer.cookie }, payload: { name: "X" } });
    expect(post.statusCode).toBe(403);
  });
});

describe("team calendar", () => {
  it("starts with Mon–Fri and no holidays", async () => {
    const admin = await setupAdmin(t.app);
    const calendar = (await t.app.inject({ url: "/api/calendar", headers: { cookie: admin } })).json();
    expect(calendar).toMatchObject({ workingWeekdays: [1, 2, 3, 4, 5], holidays: [], timeOff: [] });
  });

  it("lets only admins change the working weekdays", async () => {
    const { admin, editor } = await asEditor();
    const denied = await t.app.inject({ method: "PUT", url: "/api/calendar/working-weekdays", headers: { cookie: editor }, payload: { workingWeekdays: [1, 2, 3, 4] } });
    expect(denied.statusCode).toBe(403);
    const ok = await t.app.inject({ method: "PUT", url: "/api/calendar/working-weekdays", headers: { cookie: admin }, payload: { workingWeekdays: [1, 2, 3, 4] } });
    expect(ok.json().workingWeekdays).toEqual([1, 2, 3, 4]);
  });

  it("adds, edits and removes team-wide and targeted holidays", async () => {
    const { editor } = await asEditor();
    const ana = (await t.app.inject({ method: "POST", url: "/api/resources", headers: { cookie: editor }, payload: { name: "Ana" } })).json().resource;
    const all = await t.app.inject({
      method: "POST",
      url: "/api/holidays",
      headers: { cookie: editor },
      payload: { name: "Republic Day", startDate: "2026-10-05", endDate: "2026-10-05", appliesTo: "all" },
    });
    expect(all.statusCode).toBe(201);
    const local = (
      await t.app.inject({
        method: "POST",
        url: "/api/holidays",
        headers: { cookie: editor },
        payload: { name: "Local", startDate: "2026-10-08", endDate: "2026-10-08", appliesTo: [ana.id] },
      })
    ).json().holiday;
    await t.app.inject({
      method: "PUT",
      url: `/api/holidays/${local.id}`,
      headers: { cookie: editor },
      payload: { name: "Local fair", startDate: "2026-10-08", endDate: "2026-10-09", appliesTo: [ana.id] },
    });
    let calendar = (await t.app.inject({ url: "/api/calendar", headers: { cookie: editor } })).json();
    expect(calendar.holidays).toEqual([
      { id: all.json().holiday.id, name: "Republic Day", startDate: "2026-10-05", endDate: "2026-10-05", appliesTo: "all" },
      { id: local.id, name: "Local fair", startDate: "2026-10-08", endDate: "2026-10-09", appliesTo: [ana.id] },
    ]);
    await t.app.inject({ method: "DELETE", url: `/api/holidays/${local.id}`, headers: { cookie: editor } });
    calendar = (await t.app.inject({ url: "/api/calendar", headers: { cookie: editor } })).json();
    expect(calendar.holidays).toHaveLength(1);
  });

  it("adds, edits and removes time off", async () => {
    const { editor } = await asEditor();
    const ana = (await t.app.inject({ method: "POST", url: "/api/resources", headers: { cookie: editor }, payload: { name: "Ana" } })).json().resource;
    const entry = (
      await t.app.inject({
        method: "POST",
        url: "/api/time-off",
        headers: { cookie: editor },
        payload: { resourceId: ana.id, startDate: "2026-10-12", endDate: "2026-10-16", note: "Holidays" },
      })
    ).json().timeOff;
    expect(entry).toMatchObject({ resourceId: ana.id, note: "Holidays" });
    await t.app.inject({
      method: "PUT",
      url: `/api/time-off/${entry.id}`,
      headers: { cookie: editor },
      payload: { resourceId: ana.id, startDate: "2026-10-12", endDate: "2026-10-14" },
    });
    expect((await t.app.inject({ url: "/api/calendar", headers: { cookie: editor } })).json().timeOff).toEqual([
      { id: entry.id, resourceId: ana.id, startDate: "2026-10-12", endDate: "2026-10-14", note: "" },
    ]);
    expect((await t.app.inject({ method: "DELETE", url: `/api/time-off/${entry.id}`, headers: { cookie: editor } })).statusCode).toBe(204);
  });

  it("rejects unknown team members, reversed ranges and year-long entries", async () => {
    const { editor } = await asEditor();
    const unknown = "00000000-0000-4000-8000-000000000000";
    const responses = await Promise.all([
      t.app.inject({ method: "POST", url: "/api/time-off", headers: { cookie: editor }, payload: { resourceId: unknown, startDate: "2026-10-12", endDate: "2026-10-12" } }),
      t.app.inject({ method: "POST", url: "/api/holidays", headers: { cookie: editor }, payload: { name: "X", startDate: "2026-10-12", endDate: "2026-10-12", appliesTo: [unknown] } }),
      t.app.inject({ method: "POST", url: "/api/holidays", headers: { cookie: editor }, payload: { name: "X", startDate: "2026-10-12", endDate: "2026-10-01", appliesTo: "all" } }),
      t.app.inject({ method: "POST", url: "/api/holidays", headers: { cookie: editor }, payload: { name: "X", startDate: "2026-01-01", endDate: "2027-06-01", appliesTo: "all" } }),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([400, 400, 400, 400]);
  });

  it("bumps the instance version and logs every change", async () => {
    const { editor } = await asEditor();
    const before = (await t.app.inject({ url: "/api/calendar", headers: { cookie: editor } })).json().instanceVersion;
    await t.app.inject({
      method: "POST",
      url: "/api/holidays",
      headers: { cookie: editor },
      payload: { name: "Republic Day", startDate: "2026-10-05", endDate: "2026-10-05", appliesTo: "all" },
    });
    const after = (await t.app.inject({ url: "/api/calendar", headers: { cookie: editor } })).json().instanceVersion;
    expect(after).toBe(before + 1);
    expect(await t.db.commandLog.findFirst({ where: { projectId: null, version: after } })).toMatchObject({ name: "createHoliday", actorLabel: "Ed" });
  });
});
