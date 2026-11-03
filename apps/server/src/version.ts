import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The repository's root package.json, which carries the release's version. */
const ROOT_PACKAGE = fileURLToPath(new URL("../../../package.json", import.meta.url));

/**
 * The running version: APP_VERSION when set (release images pass it), otherwise the root
 * package.json's version (an image built straight from a release's source), otherwise "dev".
 */
export function appVersion(env: Record<string, string | undefined>, packageFile = ROOT_PACKAGE): string {
  if (env["APP_VERSION"]) return env["APP_VERSION"];
  try {
    const version: unknown = (JSON.parse(readFileSync(packageFile, "utf8")) as { version?: unknown }).version;
    return typeof version === "string" && version ? version : "dev";
  } catch {
    return "dev";
  }
}
