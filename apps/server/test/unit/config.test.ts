import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";

const SECRET = "x".repeat(32);

describe("loadConfig", () => {
  it("reads required values and applies defaults", () => {
    const { webDir: _webDir, ...config } = loadConfig({ DATABASE_URL: "postgresql://db/gp", SESSION_SECRET: SECRET }); // apps/web/dist when built
    expect(config).toEqual({
      databaseUrl: "postgresql://db/gp",
      sessionSecret: SECRET,
      publicUrl: new URL("http://localhost:3000"),
      port: 3000,
      bind: "127.0.0.1",
      trustProxy: false,
      version: "dev",
      initialAdmin: null,
      firstAdminEmail: null,
      cluster: "single",
      shutdownDelayMs: 0,
      oidc: null,
      smtp: null,
    });
  });

  it("serves the web app from WEB_DIR only when it holds a build", () => {
    const base = { DATABASE_URL: "postgresql://db/gp", SESSION_SECRET: SECRET };
    expect(loadConfig({ ...base, WEB_DIR: "/nowhere" }).webDir).toBeNull();
    expect(loadConfig({ ...base, APP_VERSION: "1.4.0" }).version).toBe("1.4.0");
  });

  it("turns single sign-on on with OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET together", () => {
    const base = { DATABASE_URL: "postgresql://db/gp", SESSION_SECRET: SECRET };
    const oidc = { OIDC_ISSUER: "https://accounts.google.com", OIDC_CLIENT_ID: "id", OIDC_CLIENT_SECRET: "secret" };
    expect(loadConfig({ ...base, ...oidc, OIDC_NAME: "Google", OIDC_ALLOWED_DOMAINS: " Example.com, @team.org ", OIDC_AUTO_CREATE: "true" }).oidc).toEqual({
      issuer: new URL("https://accounts.google.com"),
      clientId: "id",
      clientSecret: "secret",
      name: "Google",
      scopes: "openid email profile",
      allowedDomains: ["example.com", "team.org"],
      autoCreate: true,
      defaultRole: "viewer",
    });
    expect(() => loadConfig({ ...base, OIDC_ISSUER: "https://accounts.google.com" })).toThrow("Set OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET together");
    expect(() => loadConfig({ ...base, ...oidc, OIDC_DEFAULT_ROLE: "owner" })).toThrow("Invalid OIDC_DEFAULT_ROLE");
  });

  it("reads CLUSTER: single by default, or postgres", () => {
    const base = { DATABASE_URL: "postgresql://db/gp", SESSION_SECRET: SECRET };
    expect(loadConfig(base).cluster).toBe("single");
    expect(loadConfig({ ...base, CLUSTER: "postgres" }).cluster).toBe("postgres");
    expect(() => loadConfig({ ...base, CLUSTER: "redis" })).toThrow("Invalid CLUSTER: redis (use single or postgres)");
    expect(loadConfig({ ...base, CLUSTER: "postgres" }).shutdownDelayMs).toBe(5000);
    expect(loadConfig({ ...base, CLUSTER: "postgres", SHUTDOWN_DELAY_MS: "1500" }).shutdownDelayMs).toBe(1500);
    expect(() => loadConfig({ ...base, SHUTDOWN_DELAY_MS: "soon" })).toThrow("Invalid SHUTDOWN_DELAY_MS");
  });

  it("reads the first admin from ADMIN_*, checked like the setup form", () => {
    const base = { DATABASE_URL: "postgresql://db/gp", SESSION_SECRET: SECRET };
    expect(loadConfig({ ...base, ADMIN_EMAIL: "Boss@Example.com", ADMIN_PASSWORD: "long enough" }).initialAdmin).toEqual({
      email: "boss@example.com",
      name: "Admin",
      password: "long enough",
    });
    expect(() => loadConfig({ ...base, ADMIN_EMAIL: "boss@example.com" })).toThrow("Set ADMIN_PASSWORD too");
    expect(() => loadConfig({ ...base, ADMIN_PASSWORD: "long enough" })).toThrow("Set ADMIN_EMAIL too");
    // With single sign-on, ADMIN_EMAIL alone names who becomes the admin by signing in.
    const sso = { OIDC_ISSUER: "https://accounts.example.com", OIDC_CLIENT_ID: "id", OIDC_CLIENT_SECRET: "secret" };
    expect(loadConfig({ ...base, ...sso, ADMIN_EMAIL: "Boss@Example.com" })).toMatchObject({ initialAdmin: null, firstAdminEmail: "boss@example.com" });
    expect(() => loadConfig({ ...base, ADMIN_EMAIL: "boss@example.com", ADMIN_PASSWORD: "short" })).toThrow("Invalid ADMIN_* settings");
  });

  it("reads optional overrides", () => {
    const config = loadConfig({
      DATABASE_URL: "postgresql://db/gp",
      SESSION_SECRET: SECRET,
      PUBLIC_URL: "https://plan.example.com",
      PORT: "8080",
      BIND: "0.0.0.0",
    });
    expect(config).toMatchObject({ publicUrl: new URL("https://plan.example.com"), port: 8080, bind: "0.0.0.0" });
  });

  it("parses TRUST_PROXY as off, on, a hop count or an address list", () => {
    const base = { DATABASE_URL: "x", SESSION_SECRET: SECRET };
    expect(loadConfig({ ...base, TRUST_PROXY: "false" }).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(loadConfig({ ...base, TRUST_PROXY: "1" }).trustProxy).toBe(1);
    expect(loadConfig({ ...base, TRUST_PROXY: "127.0.0.1,10.0.0.0/8" }).trustProxy).toBe("127.0.0.1,10.0.0.0/8");
  });

  it("refuses to start without a database URL or a strong session secret", () => {
    expect(() => loadConfig({ SESSION_SECRET: SECRET })).toThrow(/DATABASE_URL is required/);
    expect(() => loadConfig({ DATABASE_URL: "postgresql://db/gp" })).toThrow(/SESSION_SECRET is required/);
    expect(() => loadConfig({ DATABASE_URL: "postgresql://db/gp", SESSION_SECRET: "short" })).toThrow(/at least 32/);
  });

  it("rejects invalid ports and URLs", () => {
    expect(() => loadConfig({ DATABASE_URL: "x", SESSION_SECRET: SECRET, PORT: "99999" })).toThrow(/Invalid PORT/);
    expect(() => loadConfig({ DATABASE_URL: "x", SESSION_SECRET: SECRET, PUBLIC_URL: "not a url" })).toThrow();
  });
});
