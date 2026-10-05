import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InitialAdminSettings } from "@ganttlines/protocol";
import type { InitialAdmin } from "./auth/first-run";
import { oidcSettings, type OidcSettings } from "./auth/oidc";
import { smtpSettings, type SmtpSettings } from "./mail/mailer";

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
  /** Outgoing email (SMTP_*, MAIL_FROM), when configured */
  smtp: SmtpSettings | null;
  /** Single sign-on (OIDC_*), when configured */
  oidc: OidcSettings | null;
  /** The admin to create on first start (ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME) */
  initialAdmin: InitialAdmin | null;
  /** ADMIN_EMAIL without a password (single sign-on only): whoever first signs in with it becomes the admin */
  firstAdminEmail: string | null;
  /** The running version (the image's APP_VERSION; "dev" otherwise) */
  version: string;
  /** How long a stopping server keeps answering (health says 503) before closing, so load balancers notice */
  shutdownDelayMs: number;
  /** How copies share state: "single" (one process, in memory) or "postgres" (several copies, through the database) */
  cluster: "single" | "postgres";
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
  const oidc = oidcSettings(env);
  return {
    databaseUrl,
    sessionSecret,
    publicUrl,
    port,
    bind: env["BIND"] ?? "127.0.0.1",
    trustProxy: parseTrustProxy(env["TRUST_PROXY"]),
    webDir: webDir(env["WEB_DIR"]),
    version: env["APP_VERSION"] || "dev",
    ...admins(env, oidc),
    oidc,
    smtp: smtpSettings(env),
    cluster: parseCluster(env["CLUSTER"]),
    shutdownDelayMs: parseShutdownDelay(env["SHUTDOWN_DELAY_MS"], parseCluster(env["CLUSTER"])),
  };
}

/**
 * The first admin. ADMIN_EMAIL + ADMIN_PASSWORD (+ ADMIN_NAME), checked like the setup form, create
 * it on start. With single sign-on, ADMIN_EMAIL alone names who becomes the admin by signing in.
 */
function admins(env: NodeJS.ProcessEnv, oidc: OidcSettings | null): { initialAdmin: InitialAdmin | null; firstAdminEmail: string | null } {
  const email = env["ADMIN_EMAIL"];
  const password = env["ADMIN_PASSWORD"];
  if (!email && !password) return { initialAdmin: null, firstAdminEmail: null };
  if (email && !password) {
    if (!oidc) throw new Error("Set ADMIN_PASSWORD too (ADMIN_EMAIL alone works with single sign-on, OIDC_*)");
    const parsed = InitialAdminSettings.shape.email.safeParse(email);
    if (!parsed.success) throw new Error("Invalid ADMIN_EMAIL");
    return { initialAdmin: null, firstAdminEmail: parsed.data };
  }
  if (!email) throw new Error("Set ADMIN_EMAIL too (with ADMIN_PASSWORD)");
  const parsed = InitialAdminSettings.safeParse({ email, password, name: env["ADMIN_NAME"] || "Admin" });
  if (!parsed.success) throw new Error(`Invalid ADMIN_* settings: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return { initialAdmin: parsed.data, firstAdminEmail: null };
}

/** WEB_DIR, or apps/web/dist when it has been built. */
function webDir(value: string | undefined): string | null {
  const dir = value || fileURLToPath(new URL("../../web/dist", import.meta.url));
  return existsSync(join(dir, "index.html")) ? dir : null;
}

/** SHUTDOWN_DELAY_MS, or 5 s with several copies (load balancers need a moment) and 0 with one. */
function parseShutdownDelay(value: string | undefined, cluster: "single" | "postgres"): number {
  if (value === undefined || value === "") return cluster === "postgres" ? 5000 : 0;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < 0 || ms > 120_000) throw new Error(`Invalid SHUTDOWN_DELAY_MS: ${value} (0–120000)`);
  return ms;
}

function parseCluster(value: string | undefined): "single" | "postgres" {
  if (value === undefined || value === "" || value === "single") return "single";
  if (value === "postgres") return "postgres";
  throw new Error(`Invalid CLUSTER: ${value} (use single or postgres)`);
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
