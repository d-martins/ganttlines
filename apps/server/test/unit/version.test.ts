import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appVersion } from "../../src/version";

const packageFile = (contents: string) => {
  const file = join(mkdtempSync(join(tmpdir(), "gl-version-")), "package.json");
  writeFileSync(file, contents);
  return file;
};

describe("appVersion", () => {
  it("prefers APP_VERSION", () => {
    expect(appVersion({ APP_VERSION: "1.4.0" }, packageFile('{"version":"0.6.2"}'))).toBe("1.4.0");
  });

  it("falls back to the repository's package.json version", () => {
    expect(appVersion({}, packageFile('{"version":"0.6.2"}'))).toBe("0.6.2");
    expect(appVersion({ APP_VERSION: "" }, packageFile('{"version":"0.6.2"}'))).toBe("0.6.2");
  });

  it("is dev without either", () => {
    expect(appVersion({}, packageFile('{"name":"ganttlines"}'))).toBe("dev");
    expect(appVersion({}, "/nowhere/package.json")).toBe("dev");
  });

  it("reads the repository's own package.json by default", async () => {
    const root = (await import("../../../../package.json", { with: { type: "json" } })).default as { version?: string };
    expect(appVersion({})).toBe(root.version ?? "dev");
  });
});
