import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createUser, setupAdmin, useTestApp } from "./helpers";

const t = useTestApp();

async function workspace() {
  const admin = await setupAdmin(t.app);
  const ed = (await createUser(t.app, admin, { email: "ed@example.com", name: "Ed", role: "editor" })).cookie;
  const project = async (name: string) =>
    (await t.app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ed }, payload: { name } })).json().project.id as string;
  const send = (projectId: string, command: object) =>
    t.app.inject({ method: "POST", url: `/api/projects/${projectId}/commands`, headers: { cookie: ed }, payload: { commandId: randomUUID(), command } });
  const task = async (projectId: string, tags: string[], kind: "task" | "section" = "task") => {
    const id = randomUUID();
    await send(projectId, { type: "createRow", id, kind, parentId: null, afterId: null, title: "T" });
    if (tags.length) await send(projectId, { type: "setTags", id, tags });
    return id;
  };
  return { admin, ed, project, task };
}

const tags = (cookie: string, headers: Record<string, string> = {}) => t.app.inject({ url: "/api/tags", headers: { cookie, ...headers } });

describe("GET /api/tags", () => {
  it("lists every tag in the workspace, most used first, then alphabetically, in the first spelling", async () => {
    const { ed, project, task } = await workspace();
    const launch = await project("Launch");
    await task(launch, ["UI", "Back end"]);
    await task(launch, ["UI"]);
    await task(launch, ["Zeta"]);
    await task(launch, []);
    await task(launch, [], "section");
    const other = await project("Other");
    // Stored before the workspace knew "UI" (e.g. imported): the older project's spelling wins.
    const stray = await task(other, []);
    await t.db.row.update({ where: { id: stray }, data: { tags: ["ui", "alpha"] } });
    await t.db.project.update({ where: { id: other }, data: { createdAt: new Date(Date.now() + 60_000) } });

    const response = await tags(ed);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tags: ["UI", "alpha", "Back end", "Zeta"] });
  });

  it("is empty for a workspace without tags", async () => {
    const { ed, project, task } = await workspace();
    await task(await project("Launch"), []);
    expect((await tags(ed)).json()).toEqual({ tags: [] });
  });

  it("is for editors and admins only: viewers, guests, share links and strangers can't list other projects' tags", async () => {
    const { admin, ed, project } = await workspace();
    const projectId = await project("Launch");
    expect((await tags(admin)).statusCode).toBe(200);
    expect((await tags(ed)).statusCode).toBe(200);
    for (const role of ["viewer", "guest"] as const) {
      const user = await createUser(t.app, admin, { email: `${role}@example.com`, name: role, role });
      expect((await tags(user.cookie)).statusCode, role).toBe(403);
    }
    const { token } = (await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/share-links`, headers: { cookie: admin }, payload: { access: "anonymous", collaboration: true } })).json();
    const visit = await t.app.inject({ method: "POST", url: `/api/share/${token}/visitor`, payload: { name: "Rudy" } });
    const visitor = `gp_visitor=${visit.cookies.find((c) => c.name === "gp_visitor")!.value}`;
    expect((await tags(visitor, { "x-share-token": token })).statusCode).toBe(403);
    expect((await t.app.inject({ url: "/api/tags" })).statusCode).toBe(401);
  });
});
