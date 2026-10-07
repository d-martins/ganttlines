import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createUser, setupAdmin, useTestApp } from "./helpers";
import { call, connect, enableMcp, mcpClient, registerApp } from "./mcp-support";

const t = useTestApp();

/** An editor (Ed) whose AI app may do everything; a project "Launch"; Ana on the team. */
async function editorsApp() {
  const admin = await setupAdmin(t.app);
  await enableMcp(t.app, admin, ["plans:read", "plans:write", "comments", "team:read", "team:write"]);
  const ed = await createUser(t.app, admin, { email: "ed@example.com", name: "Ed", role: "editor" });
  await t.app.inject({ method: "POST", url: "/api/resources", headers: { cookie: admin }, payload: { name: "Ana" } });
  const projectId = (await t.app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ed.cookie }, payload: { name: "Launch" } })).json().project.id as string;
  const tokens = await connect(t.app, ed.cookie, await registerApp(t.app, "Claude"));
  return { admin, ed, projectId, client: await mcpClient(t.app, tokens.access_token) };
}

const rowsOf = async (projectId: string, cookie: string) =>
  (await t.app.inject({ url: `/api/projects/${projectId}/state`, headers: { cookie } })).json().rows as { id: string; title: string; parentId: string | null }[];

describe("AI access: editing plans", () => {
  it("adds sections and tasks — following earlier ones, assigned by name — and answers with their computed dates", async () => {
    const { ed, projectId, client } = await editorsApp();
    const result = await call(client, "add_tasks", {
      project: "Launch",
      tasks: [
        { kind: "section", title: "Phase 1" },
        { title: "Design", parent: "Phase 1", start: "2026-10-05", durationDays: 3, assignee: "ana" },
        { title: "Build", parent: "Phase 1", predecessor: "Design", durationDays: 2.5 },
        { title: "Release", parent: "Phase 1", predecessor: "Build", milestone: true },
      ],
    });
    expect(result["error"]).toBeUndefined();
    expect(result["added"]).toEqual([
      expect.objectContaining({ title: "Phase 1", type: "section" }),
      expect.objectContaining({ title: "Design", start: "2026-10-05", end: "2026-10-07", assignee: expect.objectContaining({ name: "Ana" }) }),
      expect.objectContaining({ title: "Build", start: "2026-10-08", end: "2026-10-12", endsMidday: true, predecessor: expect.objectContaining({ title: "Design" }) }),
      expect.objectContaining({ title: "Release", type: "milestone", start: "2026-10-12" }),
    ]);
    // It's an ordinary change on the board, credited to Ed "via" the app.
    const history = (await t.app.inject({ url: `/api/projects/${projectId}/activity`, headers: { cookie: ed.cookie } })).json().entries;
    expect(history[0].actor.label).toBe("Ed via Claude");
    // Ed's own undo in the browser doesn't revert what his AI did (and vice versa).
    const undo = await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/undo`, headers: { cookie: ed.cookie }, payload: { commandId: randomUUID() } });
    expect(undo.json()).toMatchObject({ message: "Nothing to undo" });
    await client.close();
  });

  it("changes, moves and deletes tasks; undo reverts the last call as a whole", async () => {
    const { ed, projectId, client } = await editorsApp();
    await call(client, "add_tasks", {
      project: projectId,
      tasks: [
        { title: "Design", start: "2026-10-05", durationDays: 2 },
        { title: "Build", start: "2026-10-05", durationDays: 2 },
        { kind: "section", title: "Later" },
      ],
    });
    const updated = await call(client, "update_task", { project: "Launch", task: "build", predecessor: "Design", lagDays: 1, title: "Build it", half: "afternoon", start: "2026-10-05" });
    expect(updated["task"]).toMatchObject({ title: "Build it", start: "2026-10-08", predecessor: { title: "Design", lagDays: 1 } });

    await call(client, "move_tasks", { project: "Launch", tasks: ["Build it"], parent: "Later" });
    const later = (await rowsOf(projectId, ed.cookie)).find((row) => row.title === "Later")!;
    expect((await rowsOf(projectId, ed.cookie)).find((row) => row.title === "Build it")!.parentId).toBe(later.id);

    expect(await call(client, "delete_tasks", { project: "Launch", tasks: ["Later"] })).toMatchObject({ deleted: [{ title: "Later" }] });
    expect((await rowsOf(projectId, ed.cookie)).map((row) => row.title).sort()).toEqual(["Design"]);
    await call(client, "undo");
    expect((await rowsOf(projectId, ed.cookie)).map((row) => row.title).sort()).toEqual(["Build it", "Design", "Later"]);
    expect(await call(client, "undo")).toEqual({ error: "There's nothing to undo." });
    await client.close();
  });

  it("links the way it was asked, even when the follower starts before its predecessor", async () => {
    const { client } = await editorsApp();
    const added = await call(client, "add_tasks", {
      project: "Launch",
      tasks: [
        { title: "Design", start: "2026-10-12", durationDays: 2 },
        { title: "Build", start: "2026-10-05", durationDays: 2 },
        { title: "QA", start: "2026-10-01", predecessor: "Design", durationDays: 1 },
      ],
    });
    expect(added["error"]).toBeUndefined();
    const byTitle = (rows: unknown) => Object.fromEntries((rows as { title: string }[]).map((row) => [row.title, row]));
    // Added with an earlier start: still follows Design, placed after it.
    expect(byTitle(added["added"])["QA"]).toMatchObject({ predecessor: { title: "Design" }, start: "2026-10-14" });
    expect(byTitle(added["added"])["Design"]).toMatchObject({ predecessor: null, start: "2026-10-12" });

    // Linked later, while starting a week earlier: Build follows Design, not the other way round.
    const updated = await call(client, "update_task", { project: "Launch", task: "Build", predecessor: "Design" });
    expect(updated["error"]).toBeUndefined();
    expect(updated["task"]).toMatchObject({ title: "Build", predecessor: { title: "Design" }, start: "2026-10-14" });
    const board = byTitle((await call(client, "get_project", { project: "Launch" }))["rows"]);
    expect(board["Design"]).toMatchObject({ predecessor: null, start: "2026-10-12" });
    await client.close();
  });

  it("sets the half day on its own, and says when a start isn\u2019t where it was asked", async () => {
    const { client } = await editorsApp();
    await call(client, "add_tasks", {
      project: "Launch",
      tasks: [
        { title: "Solo", start: "2026-10-07", half: "afternoon", durationDays: 1 },
        { title: "P", start: "2026-10-12", durationDays: 3 },
        { title: "F", predecessor: "P", durationDays: 1 },
      ],
    });
    // Only the half: the same day, now in the morning.
    const morning = await call(client, "update_task", { project: "Launch", task: "Solo", half: "morning" });
    expect(morning["task"]).toMatchObject({ start: "2026-10-07" });
    expect((morning["task"] as { startsAfternoon?: boolean }).startsAfternoon).toBeFalsy();
    // A start the predecessor and lag don't allow: placed where they say, and the answer says so.
    const asked = await call(client, "update_task", { project: "Launch", task: "F", start: "2026-10-13", half: "afternoon", lagDays: 0 });
    expect(asked["error"]).toBeUndefined();
    expect(asked["task"]).toMatchObject({ start: "2026-10-15", predecessor: { title: "P" } });
    expect(asked["notes"]).toEqual(["“F” was asked to start 2026-10-13 (afternoon) but starts 2026-10-15: its predecessor and lag, or the calendar, place it there."]);
    // Stored as asked: no note.
    const solo = await call(client, "update_task", { project: "Launch", task: "Solo", start: "2026-10-08", half: "afternoon" });
    expect(solo["task"]).toMatchObject({ start: "2026-10-08", startsAfternoon: true });
    expect(solo["notes"]).toBeUndefined();
    await client.close();
  });

  it("changes nothing when part of a call fails, and says which task", async () => {
    const { ed, projectId, client } = await editorsApp();
    const result = await call(client, "add_tasks", {
      project: "Launch",
      tasks: [{ title: "One", start: "2026-10-05" }, { title: "Two", assignee: "Zed" }],
    });
    expect(result["error"]).toMatch(/^“Two”: No team member called “Zed”.* Nothing was changed\.$/);
    expect(await rowsOf(projectId, ed.cookie)).toEqual([]);
    expect(await call(client, "undo")).toEqual({ error: "There's nothing to undo." });

    // An engine refusal names the task too: a lag without a predecessor.
    await call(client, "add_tasks", { project: "Launch", tasks: [{ title: "Build", start: "2026-10-05" }] });
    const lag = await call(client, "update_task", { project: "Launch", task: "Build", title: "Build it", lagDays: 2 });
    expect(lag["error"]).toBe("“Build”: This task has no predecessor. Nothing was changed.");
    expect((await rowsOf(projectId, ed.cookie)).map((row) => row.title)).toEqual(["Build"]); // the rename was reverted too
    expect(await call(client, "add_tasks", { project: "Nope", tasks: [{ title: "x" }] })).toEqual({ error: expect.stringContaining("No project called “Nope”") });
    await client.close();
  });

  it("creates and renames projects", async () => {
    const { ed, client } = await editorsApp();
    const created = await call(client, "create_project", { name: "Website" });
    expect(created["project"]).toMatchObject({ name: "Website" });
    await call(client, "rename_project", { project: "Website", name: "New website" });
    const names = (await t.app.inject({ url: "/api/projects", headers: { cookie: ed.cookie } })).json().projects.map((p: { name: string }) => p.name);
    expect(names).toEqual(["Launch", "New website"]);
    await client.close();
  });

  it("reads and adds comments, as the person via the app", async () => {
    const { ed, projectId, client } = await editorsApp();
    await call(client, "add_tasks", { project: "Launch", tasks: [{ title: "Design", start: "2026-10-05" }] });
    expect(await call(client, "add_comment", { project: "Launch", task: "Design", text: "Looks **good**" })).toMatchObject({ comment: { task: "Design", by: "Ed via Claude" } });
    const listed = await call(client, "list_comments", { project: "Launch" });
    expect(listed["comments"]).toEqual([expect.objectContaining({ task: "Design", by: "Ed via Claude", text: "Looks **good**" })]);
    // In the web app it's Ed's (he can edit or delete it).
    const comments = (await t.app.inject({ url: `/api/projects/${projectId}/comments`, headers: { cookie: ed.cookie } })).json().comments;
    expect(comments[0]).toMatchObject({ mine: true, author: { label: "Ed via Claude" } });
    await client.close();
  });
});

describe("AI access: editing the team calendar", () => {
  it("adds people, locations, holidays, time off and a country's public holidays", async () => {
    const { client } = await editorsApp();
    expect(await call(client, "save_location", { name: "Lisbon office", country: "pt" })).toMatchObject({ location: { name: "Lisbon office", country: "PT" } });
    expect(await call(client, "add_team_member", { name: "Rui", location: "Lisbon" })).toMatchObject({ member: { name: "Rui", locationId: expect.any(String) } });
    await call(client, "update_team_member", { person: "Ana", location: "Lisbon office" });
    await call(client, "save_holiday", { name: "Team day", start: "2026-11-06", locations: ["Lisbon office"] });
    await call(client, "save_time_off", { person: "Ana", start: "2026-11-09", end: "2026-11-13", note: "Vacation" });
    const imported = await call(client, "import_public_holidays", { location: "Lisbon office", year: 2026 });
    expect(imported["added"]).toBeGreaterThan(5);
    expect(await call(client, "import_public_holidays", { location: "Lisbon office", year: 2026 })).toMatchObject({ added: 0 });

    const calendar = await call(client, "get_calendar", { from: "2026-11-01", to: "2026-12-31" });
    expect(calendar["holidays"]).toContainEqual({ name: "Team day", start: "2026-11-06", end: "2026-11-06", for: ["Lisbon office (location)"] });
    expect(calendar["holidays"]).toContainEqual(expect.objectContaining({ name: "Christmas Day", start: "2026-12-25" }));
    expect(calendar["timeOff"]).toEqual([{ person: "Ana", start: "2026-11-09", end: "2026-11-13", note: "Vacation" }]);

    await call(client, "delete_holiday", { holiday: "Team day" });
    await call(client, "delete_time_off", { person: "Ana", start: "2026-11-09" });
    const after = await call(client, "get_calendar", { from: "2026-11-01", to: "2026-11-30" });
    expect(after["timeOff"]).toEqual([]);
    expect((after["holidays"] as { name: string }[]).map((h) => h.name)).not.toContain("Team day");
    expect(await call(client, "save_location", { name: "Mars", country: "XX" })).toEqual({ error: "No public holiday data for that country" });
    await client.close();
  });

  it("gives a viewer's app no editing tools, whatever the admin allows", async () => {
    const admin = await setupAdmin(t.app);
    await enableMcp(t.app, admin, ["plans:read", "plans:write", "comments", "team:read", "team:write"]);
    const viewer = await createUser(t.app, admin, { email: "vi@example.com", name: "Vi", role: "viewer" });
    const client = await mcpClient(t.app, (await connect(t.app, viewer.cookie, await registerApp(t.app))).access_token);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("add_comment"); // viewers can comment in the web app too
    expect(names).not.toContain("add_tasks");
    expect(names).not.toContain("save_holiday");
    await client.close();
  });
});
