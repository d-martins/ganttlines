import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OidcSettings } from "../src/auth/oidc";
import { startFakeOidcProvider, type FakeIdentity, type FakeOidcProvider } from "./fake-oidc";
import { createUser, sessionCookie, setupAdmin, testApp, testConfig, useTestApp } from "./helpers";

const t = useTestApp();
let provider: FakeOidcProvider;
beforeAll(async () => {
  provider = await startFakeOidcProvider();
});
afterAll(() => provider.close());

const settings = (overrides: Partial<OidcSettings> = {}): OidcSettings => ({
  issuer: new URL(provider.issuer),
  clientId: provider.clientId,
  clientSecret: provider.clientSecret,
  name: "Test IdP",
  scopes: "openid email profile",
  allowedDomains: [],
  autoCreate: false,
  defaultRole: "viewer",
  ...overrides,
});

const pendingCookie = (response: LightMyRequestResponse) => {
  const cookie = response.cookies.find((c) => c.name === "gp_oidc");
  return cookie ? `gp_oidc=${cookie.value}` : "";
};

/** The whole round trip: start → provider approves as `identity` → callback. Returns the callback's reply. */
async function signIn(app: FastifyInstance, identity: FakeIdentity, redirect = "/p/123") {
  const start = await app.inject({ url: `/api/auth/oidc/start?redirect=${encodeURIComponent(redirect)}` });
  expect(start.statusCode).toBe(302);
  const back = new URL(await provider.approve(start.headers.location as string, identity));
  return app.inject({ url: back.pathname + back.search, headers: { cookie: pendingCookie(start) } });
}

describe("single sign-on (OIDC)", () => {
  it("is offered on the sign-in page only when configured", async () => {
    expect((await t.app.inject({ url: "/api/auth/providers" })).json()).toEqual({ oidc: null, passwordReset: false });
    expect((await t.app.inject({ url: "/api/auth/oidc/start" })).statusCode).toBe(404);
    const app = await testApp({ db: t.db, config: { ...testConfig, oidc: settings() } });
    expect((await app.inject({ url: "/api/auth/providers" })).json()).toEqual({ oidc: { name: "Test IdP" }, passwordReset: false });
    await app.close();
  });

  it("signs in an existing account by its verified email, links it, and retires its temporary password", async () => {
    const app = await testApp({ db: t.db, config: { ...testConfig, oidc: settings() } });
    const admin = await setupAdmin(app);
    const created = await app.inject({ method: "POST", url: "/api/users", headers: { cookie: admin }, payload: { email: "eve@example.com", name: "Eve", role: "editor" } });
    const { temporaryPassword } = created.json<{ temporaryPassword: string }>();

    const callback = await signIn(app, { sub: "eve-1", email: "Eve@Example.com", name: "Eve E." });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("/p/123");
    const me = await app.inject({ url: "/api/auth/me", headers: { cookie: sessionCookie(callback) } });
    expect(me.json().user).toMatchObject({ email: "eve@example.com", role: "editor", mustChangePassword: false });
    const old = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "eve@example.com", password: temporaryPassword } });
    expect(old.statusCode).toBe(401);

    // From now on the provider's id is what counts, even if the email there changes.
    const again = await signIn(app, { sub: "eve-1", email: "eve.new@example.com" });
    expect((await app.inject({ url: "/api/auth/me", headers: { cookie: sessionCookie(again) } })).json().user.email).toBe("eve@example.com");
    await app.close();
  });

  it("keeps unknown people out unless accounts are created automatically (with the default role)", async () => {
    const closed = await testApp({ db: t.db, config: { ...testConfig, oidc: settings() } });
    await setupAdmin(closed);
    const refused = await signIn(closed, { sub: "new-1", email: "newbie@example.com" });
    expect(refused.headers.location).toBe("/login?error=sso_no_account");
    await closed.close();

    const open = await testApp({ db: t.db, config: { ...testConfig, oidc: settings({ autoCreate: true, defaultRole: "viewer" }) } });
    const welcomed = await signIn(open, { sub: "new-1", email: "newbie@example.com", name: "New Bie" });
    expect(welcomed.headers.location).toBe("/p/123");
    expect((await open.inject({ url: "/api/auth/me", headers: { cookie: sessionCookie(welcomed) } })).json().user).toMatchObject({
      name: "New Bie",
      role: "viewer",
      mustChangePassword: false,
    });
    expect(await t.db.resource.count({ where: { user: { email: "newbie@example.com" } } })).toBe(1);
    await open.close();
  });

  it("refuses other domains, unverified emails, and answers that don't belong to this browser's attempt", async () => {
    const app = await testApp({ db: t.db, config: { ...testConfig, oidc: settings({ allowedDomains: ["example.com"], autoCreate: true }) } });
    expect((await signIn(app, { sub: "x", email: "x@elsewhere.org" })).headers.location).toBe("/login?error=sso_domain");
    expect((await signIn(app, { sub: "y", email: "y@example.com", email_verified: false })).headers.location).toBe("/login?error=sso_unverified");

    const start = await app.inject({ url: "/api/auth/oidc/start" });
    const back = new URL(await provider.approve(start.headers.location as string, { sub: "z", email: "z@example.com" }));
    const stolen = await app.inject({ url: back.pathname + back.search }); // no cookie: started in another browser
    expect(stolen.headers.location).toBe("/login?error=sso_failed");
    const forged = await app.inject({ url: back.pathname + back.search, headers: { cookie: `${pendingCookie(start)}x` } });
    expect(forged.headers.location).toBe("/login?error=sso_failed");
    expect(await t.db.user.count({ where: { email: "z@example.com" } })).toBe(0);
    await app.close();
  });

  it("only goes back to pages on this site", async () => {
    const app = await testApp({ db: t.db, config: { ...testConfig, oidc: settings({ autoCreate: true }) } });
    await setupAdmin(app);
    for (const target of ["//evil.example", "https://evil.example", "/\\evil.example"]) {
      expect((await signIn(app, { sub: "s", email: "s@example.com" }, target)).headers.location).toBe("/");
    }
    await app.close();
  });

  it("leaves an existing account alone when it's already linked to someone else at the provider", async () => {
    const app = await testApp({ db: t.db, config: { ...testConfig, oidc: settings() } });
    const admin = await setupAdmin(app);
    await createUser(app, admin, { email: "eve@example.com", name: "Eve", role: "editor" });
    await signIn(app, { sub: "eve-1", email: "eve@example.com" });
    const impostor = await signIn(app, { sub: "someone-else", email: "eve@example.com" });
    expect(impostor.headers.location).toBe("/login?error=sso_no_account");
    await app.close();
  });

  it("isn't held back when two-factor is required: the provider decides how people sign in", async () => {
    const app = await testApp({ db: t.db, config: { ...testConfig, oidc: settings() } });
    const admin = await setupAdmin(app);
    await createUser(app, admin, { email: "eve@example.com", name: "Eve", role: "editor" });
    await t.db.settings.upsert({ where: { id: 1 }, create: { id: 1, requireTwoFactor: "everyone" }, update: { requireTwoFactor: "everyone" } });
    const restarted = await testApp({ db: t.db, config: { ...testConfig, oidc: settings() } });
    const cookie = sessionCookie(await signIn(restarted, { sub: "eve-1", email: "eve@example.com", name: "Eve" }));
    expect((await restarted.inject({ url: "/api/auth/me", headers: { cookie } })).json().user.mustSetUpTwoFactor).toBe(false);
    expect((await restarted.inject({ url: "/api/projects", headers: { cookie } })).statusCode).toBe(200);
    await Promise.all([app.close(), restarted.close()]);
  });

  describe("on a fresh install (no accounts yet)", () => {
    const fresh = (overrides: Partial<OidcSettings> = {}, firstAdminEmail: string | null = null) =>
      testApp({ db: t.db, config: { ...testConfig, firstAdminEmail, oidc: settings({ autoCreate: true, ...overrides }) } });

    it("makes ADMIN_EMAIL the admin when they sign in first, and keeps everyone else out until then", async () => {
      const app = await fresh({}, "boss@example.com");
      expect((await app.inject({ url: "/api/auth/providers" })).json().oidc).toEqual({ name: "Test IdP", firstAdmin: true });
      const stranger = await signIn(app, { sub: "x-1", email: "someone@example.com", name: "Someone" });
      expect(stranger.headers.location).toBe("/login?error=sso_setup_pending");
      expect(await t.db.user.count()).toBe(0); // no account was auto-created ahead of the admin

      const boss = await signIn(app, { sub: "boss-1", email: "boss@example.com", name: "The Boss" });
      expect(boss.headers.location).toBe("/p/123");
      const me = (await app.inject({ url: "/api/auth/me", headers: { cookie: sessionCookie(boss) } })).json().user;
      expect(me).toMatchObject({ email: "boss@example.com", name: "The Boss", role: "admin" });
      expect((await app.inject({ url: "/api/setup" })).json()).toEqual({ needsSetup: false, localForVisitors: false });
      expect((await app.inject({ url: "/api/auth/providers" })).json().oidc).toEqual({ name: "Test IdP" });
      // From now on it's the usual rules: the stranger is auto-created with the default role.
      const later = await signIn(app, { sub: "x-1", email: "someone@example.com", name: "Someone" });
      expect((await app.inject({ url: "/api/auth/me", headers: { cookie: sessionCookie(later) } })).json().user.role).toBe("viewer");
      await app.close();
    });

    it("without ADMIN_EMAIL, makes the first person from the allowed domains the admin", async () => {
      const app = await fresh({ allowedDomains: ["example.com"] });
      const first = await signIn(app, { sub: "a-1", email: "ana@example.com", name: "Ana" });
      expect((await app.inject({ url: "/api/auth/me", headers: { cookie: sessionCookie(first) } })).json().user.role).toBe("admin");
      const second = await signIn(app, { sub: "b-1", email: "bo@example.com", name: "Bo" });
      expect((await app.inject({ url: "/api/auth/me", headers: { cookie: sessionCookie(second) } })).json().user.role).toBe("viewer");
      await app.close();
    });

    it("with neither, waits for setup with the setup code (any domain could sign in first otherwise)", async () => {
      const app = await fresh();
      expect((await app.inject({ url: "/api/auth/providers" })).json().oidc).toEqual({ name: "Test IdP" });
      expect((await signIn(app, { sub: "a-1", email: "ana@example.com", name: "Ana" })).headers.location).toBe("/login?error=sso_setup_pending");
      expect(await t.db.user.count()).toBe(0);
      await setupAdmin(app);
      const after = await signIn(app, { sub: "a-1", email: "ana@example.com", name: "Ana" });
      expect((await app.inject({ url: "/api/auth/me", headers: { cookie: sessionCookie(after) } })).json().user.role).toBe("viewer");
      await app.close();
    });
  });
});
