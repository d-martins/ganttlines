import { afterEach, describe, expect, it } from "vitest";
import { api, ApiError, setShareToken } from "../src/api/client";
import { resolveTheme, useTheme } from "../src/theme";
import { fakeApi } from "./utils";

describe("theme", () => {
  it("follows the system unless a theme is chosen", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("applies and remembers the chosen theme", () => {
    useTheme.getState().setPreference("dark");
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(localStorage.getItem("gp.theme")).toBe('"dark"');
  });
});

describe("api client", () => {
  afterEach(() => setShareToken(null));

  it("returns JSON, and undefined for 204", async () => {
    fakeApi({ "GET /api/x": () => ({ body: { ok: 1 } }), "DELETE /api/x": () => ({ status: 204 }) });
    expect(await api("GET", "/api/x")).toEqual({ ok: 1 });
    expect(await api("DELETE", "/api/x")).toBeUndefined();
  });

  it("turns server errors into ApiError with the server's code and message", async () => {
    fakeApi({ "POST /api/x": () => ({ status: 409, body: { error: "conflict", message: "Already exists" } }) });
    await expect(api("POST", "/api/x", {})).rejects.toMatchObject({ status: 409, code: "conflict", message: "Already exists" });
  });

  it("reports unreachable servers as network errors", async () => {
    const { vi } = await import("vitest");
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(api("GET", "/api/x")).rejects.toBeInstanceOf(ApiError);
    await expect(api("GET", "/api/x")).rejects.toMatchObject({ code: "network" });
  });

  it("sends the share token when one is set", async () => {
    const { vi } = await import("vitest");
    const seen: HeadersInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen.push(init.headers ?? {});
      return new Response("{}", { status: 200 });
    });
    setShareToken("abc");
    await api("GET", "/api/x");
    expect(seen[0]).toMatchObject({ "x-share-token": "abc" });
  });
});
