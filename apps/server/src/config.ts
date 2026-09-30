import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  databaseUrl: string;
  /** HMAC key for session tokens; at least 32 characters */
  sessionSecret: string;
  /** Public base URL, e.g. http://localhost:3000 — used for cookie security and origin checks */
  publicUrl: URL;
  port: number;
  bind: string;
  /**
   * Which proxies to trust for the client IP (X-Forwarded-For). `false` (default) = none, so clients
   * cannot spoof their address; a hop count (e.g. 1) or an address/CIDR list when behind a reverse proxy.
   */
  trustProxy: boolean | number | string;
  /** The built web app to serve (apps/web/dist); null when it isn't built (development, tests) */
  webDir: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const databaseUrl = required(env, "DATABASE_URL");
  const sessionSecret = required(env, "SESSION_SECRET");
  if (sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  const publicUrl = new URL(env["PUBLIC_URL"] ?? "http://localhost:3000");
  const port = Number(env["PORT"] ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid PORT: ${env["PORT"]}`);
  return {
    databaseUrl,
    sessionSecret,
    publicUrl,
    port,
    bind: env["BIND"] ?? "127.0.0.1",
    trustProxy: parseTrustProxy(env["TRUST_PROXY"]),
    webDir: webDir(env["WEB_DIR"]),
  };
}

/** WEB_DIR, or apps/web/dist when it has been built. */
function webDir(value: string | undefined): string | null {
  const dir = value || fileURLToPath(new URL("../../web/dist", import.meta.url));
  return existsSync(join(dir, "index.html")) ? dir : null;
}

function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
