import { describe, expect, it, vi } from "vitest";
import { isNewer, UpdateChecker } from "../src/updates";
import { createUser, setupAdmin, testApp, testConfig, useTestApp } from "./helpers";

const release = (tag: string) => new Response(JSON.stringify({ tag_name: tag, html_url: `https://github.com/d-martins/ganttlines/releases/tag/${tag}` }));

describe("versions", () => {
  it("compares x.y.z numerically, and never versions it can't read", () => {
    expect(isNewer("1.10.0", "1.9.3")).toBe(true);
    expect(isNewer("v2.0.0", "1.99.99")).toBe(true);
    expect(isNewer("1.2.0", "1.2.0")).toBe(false);
    expect(isNewer("1.1.9", "1.2.0")).toBe(false);
    expect(isNewer("1.3.0", "dev")).toBe(false);
    expect(isNewer("1.3.0-rc.1", "1.2.0")).toBe(false);
  });
});

describe("the update checker", () => {
  it("asks GitHub at most once a day", async () => {
    let now = 0;
    const fetchFn = vi.fn(async () => release("v1.3.0"));
    const checker = new UpdateChecker(fetchFn as unknown as typeof fetch, () => now);
    expect(await checker.latest()).toEqual({ version: "1.3.0", url: "https://github.com/d-martins/ganttlines/releases/tag/v1.3.0" });
    now += 23 * 60 * 60 * 1000;
    await checker.latest();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now += 2 * 60 * 60 * 1000;
    await checker.latest();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("stays quiet when GitHub can't be reached, and tries again an hour later", async () => {
    let now = 0;
    const fetchFn = vi.fn(async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    });
    const checker = new UpdateChecker(fetchFn as unknown as typeof fetch, () => now);
    expect(await checker.latest()).toBeNull();
    await checker.latest();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now += 61 * 60 * 1000;
    fetchFn.mockResolvedValueOnce(release("v1.3.0"));
    expect(await checker.latest()).toMatchObject({ version: "1.3.0" });
  });
});

describe("GET /api/about", () => {
  const t = useTestApp();

  it("tells admins about a newer release, and everyone the running version", async () => {
    const fetchFn = vi.fn(async () => release("v1.3.0"));
    const app = await testApp({ db: t.db, config: testConfig, updates: new UpdateChecker(fetchFn as unknown as typeof fetch) });
    const admin = await setupAdmin(app);
    const about = await app.inject({ url: "/api/about", headers: { cookie: admin } });
    expect(about.json()).toEqual({
      version: "1.2.0",
      updates: { enabled: true, available: true, latest: { version: "1.3.0", url: "https://github.com/d-martins/ganttlines/releases/tag/v1.3.0" } },
      mail: { configured: false },
    });
    expect((await app.inject({ url: "/api/about" })).statusCode).toBe(401);
    const editor = await createUser(app, admin, { email: "eve@example.com", name: "Eve", role: "editor" });
    expect((await app.inject({ url: "/api/about", headers: { cookie: editor.cookie } })).json()).toEqual({ version: "1.2.0" });
    const denied = await app.inject({ method: "PUT", url: "/api/settings/update-check", headers: { cookie: editor.cookie }, payload: { enabled: false } });
    expect(denied.statusCode).toBe(403);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("lets admins switch the check off, after which GitHub isn't asked", async () => {
    const fetchFn = vi.fn(async () => release("v1.3.0"));
    const app = await testApp({ db: t.db, config: testConfig, updates: new UpdateChecker(fetchFn as unknown as typeof fetch) });
    const admin = await setupAdmin(app);
    const off = await app.inject({ method: "PUT", url: "/api/settings/update-check", headers: { cookie: admin }, payload: { enabled: false } });
    expect(off.json()).toEqual({ enabled: false });
    expect((await app.inject({ url: "/api/about", headers: { cookie: admin } })).json()).toEqual({
      version: "1.2.0",
      updates: { enabled: false, latest: null, available: false },
      mail: { configured: false },
    });
    expect(fetchFn).not.toHaveBeenCalled();
    await app.close();
  });
});
