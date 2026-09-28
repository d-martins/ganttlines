import { describe, expect, it } from "vitest";
import { createUser, sessionCookie, setupAdmin, useTestApp } from "./helpers";

const t = useTestApp();

describe("user management (admin)", () => {
  it("creates users with a temporary password and a linked team member by default", async () => {
    const admin = await setupAdmin(t.app);
    const response = await t.app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie: admin },
      payload: { email: "Rudy@Example.com", name: "Rudy", role: "editor" },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.user).toMatchObject({ email: "rudy@example.com", role: "editor", mustChangePassword: true });
    expect(body.temporaryPassword).toHaveLength(16);
    expect(await t.db.resource.count({ where: { userId: body.user.id } })).toBe(1);
  });

  it("can skip creating a team member", async () => {
    const admin = await setupAdmin(t.app);
    const response = await t.app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie: admin },
      payload: { email: "client@example.com", name: "Client", role: "guest", createResource: false },
    });
    expect(await t.db.resource.count({ where: { userId: response.json().user.id } })).toBe(0);
  });

  it("rejects duplicate emails", async () => {
    const admin = await setupAdmin(t.app);
    const payload = { email: "rudy@example.com", name: "Rudy", role: "editor" };
    await t.app.inject({ method: "POST", url: "/api/users", headers: { cookie: admin }, payload });
    const again = await t.app.inject({ method: "POST", url: "/api/users", headers: { cookie: admin }, payload });
    expect(again.statusCode).toBe(409);
  });

  it("forces a password change before anything else", async () => {
    const admin = await setupAdmin(t.app);
    const created = await t.app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie: admin },
      payload: { email: "second@example.com", name: "Second", role: "admin" },
    });
    const login = await t.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "second@example.com", password: created.json().temporaryPassword },
    });
    const cookie = sessionCookie(login);
    const blocked = await t.app.inject({ url: "/api/users", headers: { cookie } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe("password_change_required");
    expect((await t.app.inject({ url: "/api/auth/me", headers: { cookie } })).statusCode).toBe(200);
    await t.app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: { cookie },
      payload: { currentPassword: created.json().temporaryPassword, newPassword: "my own password" },
    });
    expect((await t.app.inject({ url: "/api/users", headers: { cookie } })).statusCode).toBe(200);
  });

  it("signs out other sessions when the password changes", async () => {
    await setupAdmin(t.app);
    const first = sessionCookie(
      await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "correct horse battery" } }),
    );
    const second = await setupAdminSecondLogin();
    await t.app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: { cookie: second },
      payload: { currentPassword: "correct horse battery", newPassword: "another good password" },
    });
    expect((await t.app.inject({ url: "/api/auth/me", headers: { cookie: first } })).statusCode).toBe(401);
    expect((await t.app.inject({ url: "/api/auth/me", headers: { cookie: second } })).statusCode).toBe(200);
  });

  it("lets only admins manage users", async () => {
    const admin = await setupAdmin(t.app);
    const editor = await createUser(t.app, admin, { email: "ed@example.com", name: "Ed", role: "editor" });
    expect((await t.app.inject({ url: "/api/users", headers: { cookie: editor.cookie } })).statusCode).toBe(403);
    expect((await t.app.inject({ url: "/api/users" })).statusCode).toBe(401);
  });

  it("updates names and roles, but never removes the last admin", async () => {
    const admin = await setupAdmin(t.app);
    const me = (await t.app.inject({ url: "/api/auth/me", headers: { cookie: admin } })).json().user;
    const demote = await t.app.inject({ method: "PATCH", url: `/api/users/${me.id}`, headers: { cookie: admin }, payload: { role: "editor" } });
    expect(demote.statusCode).toBe(409);
    const rename = await t.app.inject({ method: "PATCH", url: `/api/users/${me.id}`, headers: { cookie: admin }, payload: { name: "Boss" } });
    expect(rename.json().user.name).toBe("Boss");
  });

  it("answers 409 (not 500) when the same email is created twice at once", async () => {
    const admin = await setupAdmin(t.app);
    const payload = { email: "twin@example.com", name: "Twin", role: "editor" };
    const statuses = (
      await Promise.all([1, 2].map(() => t.app.inject({ method: "POST", url: "/api/users", headers: { cookie: admin }, payload })))
    ).map((response) => response.statusCode);
    expect(statuses.sort()).toEqual([201, 409]);
  });

  it("refuses to delete yourself or the last admin", async () => {
    const admin = await setupAdmin(t.app);
    const me = (await t.app.inject({ url: "/api/auth/me", headers: { cookie: admin } })).json().user;
    expect((await t.app.inject({ method: "DELETE", url: `/api/users/${me.id}`, headers: { cookie: admin } })).statusCode).toBe(409);
    const second = await createUser(t.app, admin, { email: "second@example.com", name: "Second", role: "admin" });
    await t.app.inject({ method: "PATCH", url: `/api/users/${second.id}`, headers: { cookie: admin }, payload: { role: "editor" } });
    const other = await createUser(t.app, admin, { email: "third@example.com", name: "Third", role: "admin" });
    expect((await t.app.inject({ method: "DELETE", url: `/api/users/${me.id}`, headers: { cookie: other.cookie } })).statusCode).toBe(204);
    const lastAdmin = await t.app.inject({ method: "DELETE", url: `/api/users/${other.id}`, headers: { cookie: other.cookie } });
    expect(lastAdmin.statusCode).toBe(409);
  });

  it("resets passwords, signing the user out everywhere", async () => {
    const admin = await setupAdmin(t.app);
    const rudy = await createUser(t.app, admin, { email: "rudy@example.com", name: "Rudy", role: "editor" });
    const reset = await t.app.inject({ method: "POST", url: `/api/users/${rudy.id}/reset-password`, headers: { cookie: admin } });
    expect(reset.json().temporaryPassword).toHaveLength(16);
    expect((await t.app.inject({ url: "/api/auth/me", headers: { cookie: rudy.cookie } })).statusCode).toBe(401);
  });

  it("deletes users but keeps their team member (unlinked)", async () => {
    const admin = await setupAdmin(t.app);
    const rudy = await createUser(t.app, admin, { email: "rudy@example.com", name: "Rudy", role: "editor" });
    const response = await t.app.inject({ method: "DELETE", url: `/api/users/${rudy.id}`, headers: { cookie: admin } });
    expect(response.statusCode).toBe(204);
    expect(await t.db.resource.findFirst({ where: { name: "Rudy" } })).toMatchObject({ userId: null });
  });

  it("returns 404 for unknown or malformed user ids", async () => {
    const admin = await setupAdmin(t.app);
    for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      const response = await t.app.inject({ method: "PATCH", url: `/api/users/${id}`, headers: { cookie: admin }, payload: { name: "X" } });
      expect(response.statusCode).toBe(404);
    }
  });

  async function setupAdminSecondLogin(): Promise<string> {
    return sessionCookie(
      await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "correct horse battery" } }),
    );
  }
});
