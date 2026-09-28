import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CLOSE_SESSION_ENDED } from "../src/realtime/hub";
import { createUser, setupAdmin, useTestApp } from "./helpers";
import { connect } from "./ws-client";

const t = useTestApp();

async function projectWithLink(options: { access: "anonymous" | "authenticated"; collaboration?: boolean }) {
  const admin = await setupAdmin(t.app);
  const project = (await t.app.inject({ method: "POST", url: "/api/projects", headers: { cookie: admin }, payload: { name: "Launch" } })).json().project;
  const created = await t.app.inject({ method: "POST", url: `/api/projects/${project.id}/share-links`, headers: { cookie: admin }, payload: options });
  const { link, token, url } = created.json();
  return { admin, projectId: project.id as string, link, token: token as string, url: url as string };
}

/** Picks a display name on an anonymous link; returns the visitor cookie. */
async function visit(token: string, name = "Rudy"): Promise<string> {
  const response = await t.app.inject({ method: "POST", url: `/api/share/${token}/visitor`, payload: { name } });
  const cookie = response.cookies.find((c) => c.name === "gp_visitor");
  if (!cookie) throw new Error(`no visitor cookie: ${response.body}`);
  return `gp_visitor=${cookie.value}`;
}

const viaLink = (token: string, cookie = "") => ({ "x-share-token": token, ...(cookie ? { cookie } : {}) });
const createTask = (id: string, title = "Task") => ({ type: "createRow", id, kind: "task", parentId: null, afterId: null, title });
const command = (projectId: string, headers: Record<string, string>, cmd: object, commandId = randomUUID()) =>
  t.app.inject({ method: "POST", url: `/api/projects/${projectId}/commands`, headers, payload: { commandId, command: cmd } });

describe("managing share links", () => {
  it("lets editors create links (token shown once) and list them", async () => {
    const { admin, projectId, link, token, url } = await projectWithLink({ access: "anonymous" });
    expect(link).toMatchObject({ projectId, access: "anonymous", collaboration: false, label: "", createdBy: "Admin", revoked: false });
    expect(url).toBe(`http://localhost:3000/s/${token}`);
    const list = (await t.app.inject({ url: `/api/projects/${projectId}/share-links`, headers: { cookie: admin } })).json().links;
    expect(list).toEqual([link]);
    expect(JSON.stringify(list)).not.toContain(token);
  });

  it("does not let viewers manage links", async () => {
    const { admin, projectId } = await projectWithLink({ access: "anonymous" });
    const viewer = await createUser(t.app, admin, { email: "v@example.com", name: "Vi", role: "viewer" });
    const response = await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/share-links`, headers: { cookie: viewer.cookie }, payload: { access: "anonymous" } });
    expect(response.statusCode).toBe(403);
  });
});

describe("anonymous links", () => {
  it("describe the project and remember the visitor's name", async () => {
    const { token } = await projectWithLink({ access: "anonymous" });
    const before = (await t.app.inject({ url: `/api/share/${token}` })).json();
    expect(before).toMatchObject({ project: { name: "Launch" }, access: "anonymous", collaboration: false, needsSignIn: false, visitor: null });
    const visitor = await visit(token, "Rudy");
    expect((await t.app.inject({ url: `/api/share/${token}`, headers: { cookie: visitor } })).json().visitor).toEqual({ name: "Rudy" });
  });

  it("require a display name, then show the board read-only", async () => {
    const { projectId, token } = await projectWithLink({ access: "anonymous" });
    const anonymous = await t.app.inject({ url: `/api/projects/${projectId}/state`, headers: viaLink(token) });
    expect(anonymous.json().error).toBe("visitor_required");
    const visitor = await visit(token);
    expect((await t.app.inject({ url: `/api/projects/${projectId}/state`, headers: viaLink(token, visitor) })).statusCode).toBe(200);
    expect((await t.app.inject({ url: "/api/calendar", headers: viaLink(token, visitor) })).statusCode).toBe(200);
    expect((await command(projectId, viaLink(token, visitor), createTask(randomUUID()))).statusCode).toBe(403);
  });

  it("let visitors edit collaborative boards, recorded as '<name> (anonymous)', with their own undo", async () => {
    const { projectId, token } = await projectWithLink({ access: "anonymous", collaboration: true });
    const visitor = await visit(token, "Rudy");
    const id = randomUUID();
    expect((await command(projectId, viaLink(token, visitor), createTask(id))).statusCode).toBe(200);
    expect(await t.db.commandLog.findFirst({ where: { projectId } })).toMatchObject({ actorUserId: null, actorLabel: "Rudy (anonymous)" });
    const undo = await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/undo`, headers: viaLink(token, visitor), payload: { commandId: randomUUID() } });
    expect(undo.json()).toMatchObject({ skipped: 0 });
  });

  it("only open their own project", async () => {
    const { admin, token } = await projectWithLink({ access: "anonymous", collaboration: true });
    const other = (await t.app.inject({ method: "POST", url: "/api/projects", headers: { cookie: admin }, payload: { name: "Secret" } })).json().project;
    const visitor = await visit(token);
    expect((await t.app.inject({ url: `/api/projects/${other.id}/state`, headers: viaLink(token, visitor) })).statusCode).toBe(404);
  });

  it("ignore tampered visitor cookies", async () => {
    const { projectId, token } = await projectWithLink({ access: "anonymous" });
    const visitor = await visit(token, "Rudy");
    const [payload, signature] = visitor.slice("gp_visitor=".length).split(".");
    const forged = Buffer.from(JSON.stringify({ id: "x", name: "Admin" })).toString("base64url");
    for (const cookie of [`gp_visitor=${forged}.${signature}`, `gp_visitor=${payload}.bad`]) {
      expect((await t.app.inject({ url: `/api/projects/${projectId}/state`, headers: viaLink(token, cookie) })).statusCode).toBe(401);
    }
  });
});

describe("scope of a link visitor", () => {
  it("cannot reach anything beyond the shared board (spec §2.4)", async () => {
    const { projectId, token } = await projectWithLink({ access: "anonymous", collaboration: true });
    const headers = viaLink(token, await visit(token));
    const id = "00000000-0000-4000-8000-000000000000";
    const outOfScope: [string, string, object?][] = [
      ["PATCH", `/api/projects/${projectId}`, { name: "Hacked" }],
      ["POST", "/api/projects", { name: "New" }],
      ["GET", "/api/projects"],
      ["GET", `/api/projects/${projectId}/share-links`],
      ["POST", `/api/projects/${projectId}/share-links`, { access: "anonymous" }],
      ["PATCH", `/api/share-links/${id}`, { collaboration: true }],
      ["DELETE", `/api/share-links/${id}`],
      ["POST", "/api/resources", { name: "X" }],
      ["POST", "/api/holidays", { name: "X", startDate: "2026-10-05", endDate: "2026-10-05", appliesTo: "all" }],
      ["POST", "/api/time-off", { resourceId: id, startDate: "2026-10-05", endDate: "2026-10-05" }],
      ["PUT", "/api/calendar/working-weekdays", { workingWeekdays: [1] }],
      ["GET", "/api/users"],
      ["GET", "/api/auth/me"],
    ];
    for (const [method, url, payload] of outOfScope) {
      const response = await t.app.inject({ method: method as "GET", url, headers, ...(payload ? { payload } : {}) });
      expect([401, 403], `${method} ${url} → ${response.statusCode}`).toContain(response.statusCode);
    }
  });

  it("sees when team members are away, but not their time-off notes", async () => {
    const { admin, token } = await projectWithLink({ access: "anonymous" });
    const ana = (await t.app.inject({ method: "POST", url: "/api/resources", headers: { cookie: admin }, payload: { name: "Ana" } })).json().resource;
    await t.app.inject({ method: "POST", url: "/api/time-off", headers: { cookie: admin }, payload: { resourceId: ana.id, startDate: "2026-10-05", endDate: "2026-10-06", note: "Surgery" } });
    const viaShare = (await t.app.inject({ url: "/api/calendar", headers: viaLink(token, await visit(token)) })).json();
    expect(viaShare.timeOff).toEqual([expect.objectContaining({ resourceId: ana.id, startDate: "2026-10-05", note: "" })]);
    expect((await t.app.inject({ url: "/api/calendar", headers: { cookie: admin } })).json().timeOff[0].note).toBe("Surgery");
  });

  it("cleans display names so they cannot hide the '(anonymous)' suffix", async () => {
    const { projectId, token } = await projectWithLink({ access: "anonymous", collaboration: true });
    const visitor = await visit(token, "Ana\u202e  \nAdmin");
    await command(projectId, viaLink(token, visitor), createTask(randomUUID()));
    expect((await t.db.commandLog.findFirst({ where: { projectId } }))?.actorLabel).toBe("Ana Admin (anonymous)");
  });
});

describe("authenticated links and guests", () => {
  it("let signed-in viewers edit through a collaborative link", async () => {
    const { admin, projectId, token } = await projectWithLink({ access: "authenticated", collaboration: true });
    const viewer = await createUser(t.app, admin, { email: "v@example.com", name: "Vi", role: "viewer" });
    expect((await command(projectId, { cookie: viewer.cookie }, createTask(randomUUID()))).statusCode).toBe(403);
    expect((await command(projectId, viaLink(token, viewer.cookie), createTask(randomUUID()))).statusCode).toBe(200);
  });

  it("tell users who must change their password to do so", async () => {
    const { admin, projectId } = await projectWithLink({ access: "authenticated" });
    const created = (await t.app.inject({ method: "POST", url: "/api/users", headers: { cookie: admin }, payload: { email: "p@example.com", name: "P", role: "editor" } })).json();
    const login = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "p@example.com", password: created.temporaryPassword } });
    const cookie = `gp_session=${login.cookies.find((c) => c.name === "gp_session")!.value}`;
    expect((await t.app.inject({ url: `/api/projects/${projectId}/state`, headers: { cookie } })).json().error).toBe("password_change_required");
  });

  it("need a signed-in user, and give guests access to that one project", async () => {
    const { admin, projectId, token } = await projectWithLink({ access: "authenticated" });
    const guest = await createUser(t.app, admin, { email: "client@example.com", name: "Client", role: "guest" });
    expect((await t.app.inject({ url: `/api/projects/${projectId}/state`, headers: viaLink(token) })).json().error).toBe("sign_in_required");
    expect((await t.app.inject({ url: `/api/projects/${projectId}/state`, headers: { cookie: guest.cookie } })).statusCode).toBe(403);
    expect((await t.app.inject({ url: `/api/projects/${projectId}/state`, headers: viaLink(token, guest.cookie) })).statusCode).toBe(200);
    expect((await t.app.inject({ url: "/api/projects", headers: { cookie: guest.cookie } })).json().projects).toEqual([]);
    expect((await t.app.inject({ url: `/api/share/${token}`, headers: { cookie: guest.cookie } })).json().needsSignIn).toBe(false);
  });

  it("do not allow picking an anonymous name", async () => {
    const { token } = await projectWithLink({ access: "authenticated" });
    expect((await t.app.inject({ method: "POST", url: `/api/share/${token}/visitor`, payload: { name: "X" } })).statusCode).toBe(400);
  });
});

describe("changing and revoking links", () => {
  it("stops edits when collaboration is turned off and all access when revoked", async () => {
    const { admin, projectId, link, token } = await projectWithLink({ access: "anonymous", collaboration: true });
    const visitor = await visit(token);
    expect((await command(projectId, viaLink(token, visitor), createTask(randomUUID()))).statusCode).toBe(200);
    await t.app.inject({ method: "PATCH", url: `/api/share-links/${link.id}`, headers: { cookie: admin }, payload: { collaboration: false } });
    expect((await command(projectId, viaLink(token, visitor), createTask(randomUUID()))).statusCode).toBe(403);
    await t.app.inject({ method: "DELETE", url: `/api/share-links/${link.id}`, headers: { cookie: admin } });
    expect((await t.app.inject({ url: `/api/projects/${projectId}/state`, headers: viaLink(token, visitor) })).statusCode).toBe(410);
    expect((await t.app.inject({ url: `/api/share/${token}` })).json().error).toBe("link_revoked");
  });

  it("does not count revoked links as guesses (reconnecting tabs must not lock out an IP)", async () => {
    const { admin, projectId, link, token } = await projectWithLink({ access: "anonymous" });
    const other = (await t.app.inject({ method: "POST", url: `/api/projects/${projectId}/share-links`, headers: { cookie: admin }, payload: { access: "anonymous" } })).json();
    await t.app.inject({ method: "DELETE", url: `/api/share-links/${link.id}`, headers: { cookie: admin } });
    for (let i = 0; i < 12; i++) await t.app.inject({ url: `/api/share/${token}` });
    expect((await t.app.inject({ url: `/api/share/${other.token}` })).statusCode).toBe(200);
  });

  it("throttles guessing tokens", async () => {
    await setupAdmin(t.app);
    for (let i = 0; i < 10; i++) await t.app.inject({ url: `/api/share/guess-${i}` });
    expect((await t.app.inject({ url: "/api/share/guess-final" })).statusCode).toBe(429);
  });
});

describe("share links over the WebSocket", () => {
  it("let visitors join with their name, and closes their sockets when the link is revoked", async () => {
    const { admin, projectId, link, token } = await projectWithLink({ access: "anonymous" });
    const visitor = await visit(token, "Rudy");
    const client = await connect(t.app, visitor, undefined, `/ws?share=${token}`);
    client.send({ type: "join", projectId, version: 0 });
    expect((await client.next("joined")).viewers).toEqual([{ id: expect.stringMatching(/^visitor:/), name: "Rudy (anonymous)" }]);
    client.send({ type: "command", commandId: randomUUID(), command: createTask(randomUUID()) });
    expect(await client.next("reject")).toMatchObject({ error: "forbidden" });
    await t.app.inject({ method: "DELETE", url: `/api/share-links/${link.id}`, headers: { cookie: admin } });
    expect(await client.closed).toBe(CLOSE_SESSION_ENDED);
  });

  it("refuse sockets with unknown links or without a visitor name", async () => {
    const { token } = await projectWithLink({ access: "anonymous" });
    await expect(connect(t.app, "", undefined, "/ws?share=nope")).rejects.toThrow(/404/);
    await expect(connect(t.app, "", undefined, `/ws?share=${token}`)).rejects.toThrow(/401/);
  });

  it("keep link visitors out of other projects' rooms", async () => {
    const { admin, token } = await projectWithLink({ access: "anonymous" });
    const other = (await t.app.inject({ method: "POST", url: "/api/projects", headers: { cookie: admin }, payload: { name: "Secret" } })).json().project;
    const visitor = await visit(token);
    const client = await connect(t.app, visitor, undefined, `/ws?share=${token}`);
    client.send({ type: "join", projectId: other.id, version: 0 });
    expect(await client.next("error")).toMatchObject({ message: "Share link not found" });
  });
});
