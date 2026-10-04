import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { BASE_URL, OIDC_PORT, PORT } from "./support";

const ROOT = join(__dirname, "..");
const WEB_DIR = join(ROOT, "apps/web/dist");

/** A throwaway PostgreSQL and the production server (`ganttlines start`) on it; returns the teardown. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(join(WEB_DIR, "index.html"))) throw new Error("Build the web app first: yarn workspace @ganttlines/web build");
  const database = await new PostgreSqlContainer("postgres:17").start();
  const databaseUrl = database.getConnectionUri();
  process.env["E2E_DATABASE_URL"] = databaseUrl; // for the tests' database resets

  // A test OpenID provider, so single sign-on can be tried end to end.
  const provider = spawn(process.execPath, ["--import", "tsx", "apps/server/test/fake-oidc-cli.ts", String(OIDC_PORT)], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
  const providerLine = await new Promise<string>((resolve, reject) => {
    provider.stdout?.on("data", (chunk: Buffer) => chunk.toString().includes("fake-oidc listening") && resolve(chunk.toString()));
    provider.once("exit", (code) => reject(new Error(`The test OpenID provider exited (code ${code})`)));
  });
  const [, issuer, clientId, clientSecret] = /listening: (\S+) client=(\S+) secret=(\S+)/.exec(providerLine) ?? [];

  const server: ChildProcess = spawn(process.execPath, ["--import", "tsx", "apps/server/src/cli.ts", "start"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      SESSION_SECRET: randomBytes(32).toString("hex"),
      PUBLIC_URL: BASE_URL,
      PORT: String(PORT),
      BIND: "127.0.0.1",
      WEB_DIR,
      BACKUP_DIR: mkdtempSync(join(tmpdir(), "gp-e2e-backups-")),
      APP_VERSION: "e2e",
      PRISMA_HIDE_UPDATE_MESSAGE: "1",
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: clientId,
      OIDC_CLIENT_SECRET: clientSecret,
      OIDC_NAME: "Test IdP",
    },
  });
  let output = "";
  const keep = (chunk: Buffer) => (output = (output + chunk.toString()).slice(-20_000));
  server.stdout?.on("data", keep);
  server.stderr?.on("data", keep);

  try {
    await waitUntilUp(server);
    // A brand-new install prints a one-time setup code for creating the admin in the browser.
    const code = /setup code: ([A-Z0-9]{5}-[A-Z0-9]{5})/.exec(output)?.[1];
    if (!code) throw new Error("The server didn't print a setup code");
    process.env["E2E_SETUP_CODE"] = code;
  } catch (error) {
    server.kill();
    provider.kill();
    await database.stop();
    throw new Error(`${(error as Error).message}\n--- server output ---\n${output}`);
  }

  return async () => {
    server.kill("SIGTERM");
    await new Promise((resolve) => (server.exitCode !== null ? resolve(null) : server.once("exit", resolve)));
    provider.kill();
    await database.stop();
  };
}

async function waitUntilUp(server: ChildProcess): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`The server exited (code ${server.exitCode})`);
    try {
      if ((await fetch(`${BASE_URL}/api/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The server didn't start within 90 s");
}
