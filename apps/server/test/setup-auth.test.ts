import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { ADMIN, SETUP_CODE, sessionCookie, setupAdmin, testConfig, useTestApp } from "./helpers";

const t = useTestApp();

describe("first-run setup", () => {
  it("reports that setup is needed until an admin exists", async () => {
    expect((await t.app.inject("/api/setup")).json()).toEqual({ needsSetup: true });
    await setupAdmin(t.app);
    expect((await t.app.inject("/api/setup")).json()).toEqual({ needsSetup: false });
  });

  it("creates the admin with a linked team member and signs them in", async () => {
    const response = await t.app.inject({ method: "POST", url: "/api/setup", payload: { ...ADMIN, setupCode: SETUP_CODE } });
    expect(response.statusCode).toBe(201);
    expect(response.json().user).toMatchObject({ email: ADMIN.email, role: "admin", mustChangePassword: false });
    const me = await t.app.inject({ url: "/api/auth/me", headers: { cookie: sessionCookie(response) } });
    expect(me.json().user.email).toBe(ADMIN.email);
    expect(await t.db.resource.count({ where: { user: { email: ADMIN.email } } })).toBe(1);
  });

  it("records setup as one instance change that creates the admin and their team member", async () => {
    await setupAdmin(t.app);
    expect(await t.db.commandLog.findMany({ where: { projectId: null }, select: { name: true, actorLabel: true } })).toEqual([
      { name: "setup", actorLabel: ADMIN.name },
    ]);
  });

  it("can only run once", async () => {
    await setupAdmin(t.app);
    const again = await t.app.inject({ method: "POST", url: "/api/setup", payload: { ...ADMIN, email: "x@example.com", setupCode: SETUP_CODE } });
    expect(again.statusCode).toBe(409);
  });

  it("needs the setup code from the server's log (any case, with or without the dash)", async () => {
    const wrong = await t.app.inject({ method: "POST", url: "/api/setup", payload: { ...ADMIN, setupCode: "NOPE-NOPE1" } });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error).toBe("wrong_setup_code");
    expect(await t.db.user.count()).toBe(0);
    const right = await t.app.inject({ method: "POST", url: "/api/setup", payload: { ...ADMIN, setupCode: " tests setup " } });
    expect(right.statusCode).toBe(201);
  });

  it("makes up a random code and prints it when there's no fixed one", async () => {
    const said: string[] = [];
    // (with TEST_CLUSTER=postgres, the suite's own app is another copy that stored its code already)
    await t.db.settings.updateMany({ data: { setupCode: null } });
    const app = await buildApp({ db: t.db, config: testConfig, announce: (message) => said.push(message) });
    expect(said).toEqual([expect.stringMatching(/setup code: [A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/)]);
    const code = said[0]!.split(": ")[1]!;
    expect((await app.inject("/api/setup")).json()).toEqual({ needsSetup: true }); // asking again doesn't print a new one
    expect(said).toHaveLength(1);
    const response = await app.inject({ method: "POST", url: "/api/setup", payload: { ...ADMIN, setupCode: code } });
    expect(response.statusCode).toBe(201);
    await app.close();
  });

  it("creates the admin from ADMIN_* settings on first start, and never touches it again", async () => {
    const said: string[] = [];
    const initialAdmin = { email: "boss@example.com", name: "Boss", password: "from the settings" };
    const app = await buildApp({ db: t.db, config: { ...testConfig, initialAdmin }, announce: (message) => said.push(message) });
    expect(said).toEqual([expect.stringContaining("Created the admin account boss@example.com")]);
    expect((await app.inject("/api/setup")).json()).toEqual({ needsSetup: false });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "boss@example.com", password: "from the settings" } });
    expect(login.json().user).toMatchObject({ role: "admin", name: "Boss", mustChangePassword: false });
    await app.close();
    // A later start with other settings changes nothing.
    const again = await buildApp({ db: t.db, config: { ...testConfig, initialAdmin: { ...initialAdmin, password: "something else" } } });
    const stale = await again.inject({ method: "POST", url: "/api/auth/login", payload: { email: "boss@example.com", password: "something else" } });
    expect(stale.statusCode).toBe(401);
    expect(await t.db.user.count()).toBe(1);
    await again.close();
  });

  it("validates the payload", async () => {
    const response = await t.app.inject({ method: "POST", url: "/api/setup", payload: { email: "nope", name: "", password: "x", setupCode: SETUP_CODE } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_request");
  });
});

describe("login, logout and sessions", () => {
  it("logs in with correct credentials (email is case-insensitive) and sets an httpOnly cookie", async () => {
    await setupAdmin(t.app);
    const response = await t.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "ADMIN@example.com", password: ADMIN.password },
    });
    expect(response.statusCode).toBe(200);
    const cookie = response.cookies.find((c) => c.name === "gp_session");
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
  });

  it("rejects wrong passwords and unknown emails the same way", async () => {
    await setupAdmin(t.app);
    for (const payload of [{ email: ADMIN.email, password: "wrong" }, { email: "who@example.com", password: "x" }]) {
      const response = await t.app.inject({ method: "POST", url: "/api/auth/login", payload });
      expect(response.statusCode).toBe(401);
      expect(response.json().error).toBe("invalid_credentials");
    }
  });

  it("lets no more than 10 wrong passwords through, even sent all at once", async () => {
    await setupAdmin(t.app);
    const responses = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        t.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: `10.0.0.${i}`, payload: { email: ADMIN.email, password: "wrong" } }),
      ),
    );
    expect(responses.filter((response) => response.statusCode === 401)).toHaveLength(10);
  });

  it("a successful sign-in doesn't clear its address's failures", async () => {
    await setupAdmin(t.app);
    const login = (email: string, password: string) =>
      t.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "198.51.100.9", payload: { email, password } });
    for (let i = 0; i < 9; i++) expect((await login(`guess${i}@example.com`, "wrong")).statusCode).toBe(401);
    expect((await login(ADMIN.email, ADMIN.password)).statusCode).toBe(200);
    expect((await login("guess9@example.com", "wrong")).statusCode).toBe(401);
    expect((await login("guess10@example.com", "wrong")).statusCode).toBe(429);
  });

  it("blocks an account after 10 failed attempts", async () => {
    await setupAdmin(t.app);
    for (let i = 0; i < 10; i++) {
      await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN.email, password: "wrong" } });
    }
    const blocked = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN.email, password: ADMIN.password } });
    expect(blocked.statusCode).toBe(429);
  });

  it("throttles per client IP and ignores spoofed X-Forwarded-For by default", async () => {
    await setupAdmin(t.app);
    for (let i = 0; i < 10; i++) {
      await t.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "x-forwarded-for": `10.0.0.${i}` },
        payload: { email: `nobody${i}@example.com`, password: "wrong" },
      });
    }
    const blocked = await t.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "x-forwarded-for": "10.9.9.9" },
      payload: { email: ADMIN.email, password: ADMIN.password },
    });
    expect(blocked.statusCode).toBe(429);
  });

  it("throttles guesses of the current password when changing it", async () => {
    const cookie = await setupAdmin(t.app);
    for (let i = 0; i < 10; i++) {
      await t.app.inject({
        method: "POST",
        url: "/api/auth/password",
        headers: { cookie },
        payload: { currentPassword: "wrong", newPassword: "whatever password" },
      });
    }
    const blocked = await t.app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: { cookie },
      payload: { currentPassword: ADMIN.password, newPassword: "whatever password" },
    });
    expect(blocked.statusCode).toBe(429);
  });

  it("logs out by revoking the session", async () => {
    const cookie = await setupAdmin(t.app);
    expect((await t.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } })).statusCode).toBe(204);
    expect((await t.app.inject({ url: "/api/auth/me", headers: { cookie } })).statusCode).toBe(401);
  });

  it("keeps sessions alive for 30 days after the last visit (sliding)", async () => {
    const cookie = await setupAdmin(t.app);
    t.clock.now = new Date("2026-10-25T09:00:00Z"); // 24 days later: still valid, and extended
    const visit = await t.app.inject({ url: "/api/auth/me", headers: { cookie } });
    expect(visit.statusCode).toBe(200);
    expect(visit.cookies.find((c) => c.name === "gp_session")?.expires?.toISOString()).toBe("2026-11-24T09:00:00.000Z");
    t.clock.now = new Date("2026-11-20T09:00:00Z"); // 50 days after login, 26 after the last visit
    expect((await t.app.inject({ url: "/api/auth/me", headers: { cookie } })).statusCode).toBe(200);
  });

  it("expires sessions after 30 days without a visit", async () => {
    const cookie = await setupAdmin(t.app);
    t.clock.now = new Date("2026-11-01T09:00:00Z");
    expect((await t.app.inject({ url: "/api/auth/me", headers: { cookie } })).statusCode).toBe(401);
    expect(await t.db.session.count()).toBe(0);
  });

  it("deletes sessions that expired without coming back", async () => {
    await setupAdmin(t.app);
    const { SessionStore } = await import("../src/auth/sessions");
    const store = new SessionStore(t.db, "x".repeat(32), () => new Date("2026-11-15T00:00:00Z"));
    expect(await store.deleteExpired()).toBe(1);
    expect(await t.db.session.count()).toBe(0);
  });

  it("lets users who must change their password still log out", async () => {
    const admin = await setupAdmin(t.app);
    const created = (
      await t.app.inject({ method: "POST", url: "/api/users", headers: { cookie: admin }, payload: { email: "r@example.com", name: "R", role: "editor" } })
    ).json();
    const cookie = sessionCookie(
      await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "r@example.com", password: created.temporaryPassword } }),
    );
    expect((await t.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } })).statusCode).toBe(204);
  });

  it("accepts same-origin state-changing requests", async () => {
    await setupAdmin(t.app);
    const response = await t.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: "http://localhost:3000" },
      payload: { email: ADMIN.email, password: ADMIN.password },
    });
    expect(response.statusCode).toBe(200);
  });

  it("rejects cross-origin state-changing requests", async () => {
    await setupAdmin(t.app);
    const response = await t.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: "https://evil.example" },
      payload: { email: ADMIN.email, password: ADMIN.password },
    });
    expect(response.statusCode).toBe(403);
  });
});
