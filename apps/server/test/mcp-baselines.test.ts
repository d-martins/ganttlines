import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_BASELINES_PER_PROJECT } from "../src/routes/baselines";
import { createUser, setupAdmin, useTestApp } from "./helpers";
import { call, connect, enableMcp, mcpClient, registerApp } from "./mcp-support";

const t = useTestApp();
afterEach(() => vi.restoreAllMocks());

/** An editor (Ed) whose AI app may read and edit plans; a project "Launch" with Design (3 days from Mon Oct 5) then Build. */
async function editorsApp(scopes = ["plans:read", "plans:write"]) {
  const admin = await setupAdmin(t.app);
  await enableMcp(t.app, admin, ["plans:read", "plans:write"]);
  const ed = await createUser(t.app, admin, { email: "ed@example.com", name: "Ed", role: "editor" });
  const projectId = (await t.app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ed.cookie }, payload: { name: "Launch" } })).json().project.id as string;
  const tokens = await connect(t.app, ed.cookie, await registerApp(t.app, "Claude"), { scopes, grant: scopes });
  const client = await mcpClient(t.app, tokens.access_token);
  if (scopes.includes("plans:write")) {
    await call(client, "add_tasks", {
      project: "Launch",
      tasks: [
        { title: "Design", start: "2026-10-05", durationDays: 3 },
        { title: "Build", predecessor: "Design", durationDays: 2 },
      ],
    });
  }
  return { admin, ed, projectId, client };
}

const baselinesOf = async (projectId: string, cookie: string) =>
  (await t.app.inject({ url: `/api/projects/${projectId}/baselines`, headers: { cookie } })).json().baselines as { id: string; name: string; createdBy: string }[];

describe("AI access: baselines", () => {
  it("saves a baseline, credited to the person via their app, and lists it", async () => {
    const { ed, projectId, client } = await editorsApp();
    const saved = await call(client, "save_baseline", { project: "Launch", name: "Kick-off plan" });
    expect(saved["error"]).toBeUndefined();
    expect(saved["baseline"]).toEqual(expect.objectContaining({ name: "Kick-off plan", createdBy: "Ed via Claude" }));
    // The same baseline the board's Baseline menu shows.
    expect(await baselinesOf(projectId, ed.cookie)).toEqual([expect.objectContaining({ name: "Kick-off plan", createdBy: "Ed via Claude" })]);
    const listed = await call(client, "list_baselines", { project: "Launch" });
    expect(listed["baselines"]).toEqual([expect.objectContaining({ name: "Kick-off plan", createdBy: "Ed via Claude" })]);
    await client.close();
  });

  it("reads a baseline beside the board as it is now: each task's saved and current dates, and how far it moved", async () => {
    const { client } = await editorsApp();
    await call(client, "save_baseline", { project: "Launch", name: "Kick-off plan" });
    await call(client, "update_task", { project: "Launch", task: "Design", durationDays: 5 });
    await call(client, "add_tasks", { project: "Launch", tasks: [{ title: "Docs", start: "2026-10-05", durationDays: 1 }] });
    const result = await call(client, "get_baseline", { project: "Launch", baseline: "kick-off plan" });
    expect(result["error"]).toBeUndefined();
    expect(result["baseline"]).toEqual(expect.objectContaining({ name: "Kick-off plan" }));
    const tasks = result["tasks"] as Record<string, unknown>[];
    expect(tasks).toEqual(
      expect.arrayContaining([
        // Design ends two working days later; Build follows it, so it moves by two working days.
        expect.objectContaining({ title: "Design", saved: { start: "2026-10-05", end: "2026-10-07" }, now: { start: "2026-10-05", end: "2026-10-09" }, startMovedDays: 0, endMovedDays: 2 }),
        expect.objectContaining({ title: "Build", saved: { start: "2026-10-08", end: "2026-10-09" }, now: { start: "2026-10-12", end: "2026-10-13" }, startMovedDays: 2, endMovedDays: 2 }),
      ]),
    );
    // Tasks added since aren't in the baseline; the answer says so.
    expect(result["addedSince"]).toEqual([expect.objectContaining({ title: "Docs" })]);
    await client.close();
  });

  it("deletes a baseline", async () => {
    const { ed, projectId, client } = await editorsApp();
    await call(client, "save_baseline", { project: "Launch", name: "Old" });
    const deleted = await call(client, "delete_baseline", { project: "Launch", baseline: "Old" });
    expect(deleted["error"]).toBeUndefined();
    expect(await baselinesOf(projectId, ed.cookie)).toEqual([]);
    await client.close();
  });

  it("an unknown baseline is a problem the AI can read", async () => {
    const { client } = await editorsApp();
    const result = await call(client, "get_baseline", { project: "Launch", baseline: "Nope" });
    expect(String(result["error"])).toMatch(/baseline/i);
    await client.close();
  });

  it("keeps the per-project limit", async () => {
    const { projectId, client } = await editorsApp();
    await t.db.baseline.createMany({
      data: Array.from({ length: MAX_BASELINES_PER_PROJECT }, (_, index) => ({ projectId, name: `B${index}`, createdByLabel: "Ed", snapshot: [] })),
    });
    const result = await call(client, "save_baseline", { project: "Launch", name: "One too many" });
    expect(String(result["error"])).toContain(`At most ${MAX_BASELINES_PER_PROJECT} baselines`);
    await client.close();
  });

  it("an app that may only read plans can list and read baselines, but not save or delete them", async () => {
    const { client } = await editorsApp(["plans:read"]);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["list_baselines", "get_baseline"]));
    expect(names).not.toContain("save_baseline");
    expect(names).not.toContain("delete_baseline");
    await client.close();
  });
});
