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
    });
  });

  it("serves the web app from WEB_DIR only when it holds a build", () => {
    const base = { DATABASE_URL: "postgresql://db/gp", SESSION_SECRET: SECRET };
    expect(loadConfig({ ...base, WEB_DIR: "/nowhere" }).webDir).toBeNull();
    expect(loadConfig({ ...base, APP_VERSION: "1.4.0" }).version).toBe("1.4.0");
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
