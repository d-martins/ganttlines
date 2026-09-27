import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";

const SECRET = "x".repeat(32);

describe("loadConfig", () => {
  it("reads required values and applies defaults", () => {
    const config = loadConfig({ DATABASE_URL: "postgresql://db/gp", SESSION_SECRET: SECRET });
    expect(config).toEqual({
      databaseUrl: "postgresql://db/gp",
      sessionSecret: SECRET,
      publicUrl: new URL("http://localhost:3000"),
      port: 3000,
      bind: "127.0.0.1",
    });
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
