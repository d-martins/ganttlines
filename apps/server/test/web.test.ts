import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "@ganttlines/db";
import { afterAll, describe, expect, inject, it } from "vitest";
import { testApp, testConfig } from "./helpers";

describe("serving the web app", async () => {
  const webDir = mkdtempSync(join(tmpdir(), "gp-web-"));
  mkdirSync(join(webDir, "assets"));
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>GanttLines</title>");
  writeFileSync(join(webDir, "assets", "index-abc123.js"), "console.log(1)");
  const db = createDb(inject("databaseUrl"));
  const app = await testApp({ db, config: { ...testConfig, webDir } });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it("serves index.html for pages, including client-side routes, never cached", async () => {
    for (const url of ["/", "/p/123", "/s/token?x=1", "/settings"]) {
      const response = await app.inject({ url });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers["content-type"]).toMatch(/text\/html/);
      expect(response.headers["cache-control"]).toBe("no-cache");
      expect(response.headers["referrer-policy"], url).toBe("no-referrer"); // link and reset tokens are in page addresses
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.body).toContain("GanttLines");
    }
  });

  it("caches hashed assets for good, and 404s unknown assets and API paths as JSON", async () => {
    const asset = await app.inject({ url: "/assets/index-abc123.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    for (const [method, url] of [["GET", "/assets/missing.js"], ["GET", "/api/nope"], ["POST", "/somewhere"]] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode, url).toBe(404);
      expect(response.json()).toMatchObject({ error: "not_found" });
    }
    expect((await app.inject({ url: "/api/health" })).json()).toEqual({ ok: true });
  });
});
