import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, Wait } from "testcontainers";
import { BASE_URL, BASE_URL_2, OIDC_PORT, PORT, PORT_2 } from "./support";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const ROOT = join(__dirname, "..");
const WEB_DIR = join(ROOT, "apps/web/dist");

/**
 * A throwaway PostgreSQL and two copies of the production server (`ganttlines start`) on it, in
 * postgres mode, so tests can also put people on different copies; returns the teardown.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(join(WEB_DIR, "index.html"))) throw new Error("Build the web app first: yarn workspace @ganttlines/web build");
  if (!existsSync(join(LOCAL_DIR, "index.html"))) throw new Error("Build the local-only app first: yarn workspace @ganttlines/web build:local");
  const database = await new PostgreSqlContainer("postgres:17").start();
  const databaseUrl = database.getConnectionUri();
  process.env["E2E_DATABASE_URL"] = databaseUrl; // for the tests' database resets

  // A mail catcher (SMTP in, HTTP API out), so invitations and password resets can be followed.
  const mailpit = await new GenericContainer("axllent/mailpit:v1.27")
    .withExposedPorts(1025, 8025)
    .withWaitStrategy(Wait.forHttp("/api/v1/info", 8025))
    .start();
  process.env["E2E_MAILPIT_URL"] = `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}`;

  // A test OpenID provider, so single sign-on can be tried end to end.
  const provider = spawn(process.execPath, ["--import", "tsx", "apps/server/test/fake-oidc-cli.ts", String(OIDC_PORT)], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
  const providerLine = await new Promise<string>((resolve, reject) => {
    provider.stdout?.on("data", (chunk: Buffer) => chunk.toString().includes("fake-oidc listening") && resolve(chunk.toString()));
    provider.once("exit", (code) => reject(new Error(`The test OpenID provider exited (code ${code})`)));
  });
  const [, issuer, clientId, clientSecret] = /listening: (\S+) client=(\S+) secret=(\S+)/.exec(providerLine) ?? [];

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    BIND: "127.0.0.1",
    WEB_DIR,
    BACKUP_DIR: mkdtempSync(join(tmpdir(), "gp-e2e-backups-")),
    APP_VERSION: "e2e",
    PRISMA_HIDE_UPDATE_MESSAGE: "1",
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: clientId,
    OIDC_CLIENT_SECRET: clientSecret,
    OIDC_NAME: "Test IdP",
    SMTP_HOST: mailpit.getHost(),
    SMTP_PORT: String(mailpit.getMappedPort(1025)),
    MAIL_FROM: "GanttLines <plan@example.test>",
    SESSION_SECRET: randomBytes(32).toString("hex"),
    CLUSTER: "postgres",
  };
  // Each copy's PUBLIC_URL is the address browsers use for it (the Origin check depends on it).
  const start = (port: number, publicUrl: string, extra: NodeJS.ProcessEnv = {}) =>
    spawn(process.execPath, ["--import", "tsx", "apps/server/src/cli.ts", "start"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...environment, ...extra, PORT: String(port), PUBLIC_URL: publicUrl },
    });
  const server: ChildProcess = start(PORT, BASE_URL);
  let server2: ChildProcess | undefined;
  let output = "";
  const keep = (chunk: Buffer) => (output = (output + chunk.toString()).slice(-20_000));
  server.stdout?.on("data", keep);
  server.stderr?.on("data", keep);

  try {
    await waitUntilUp(server, BASE_URL);
    // A brand-new install prints a one-time setup code for creating the admin in the browser.
    const code = /setup code: ([A-Z0-9]{5}-[A-Z0-9]{5})/.exec(output)?.[1];
    if (!code) throw new Error("The server didn't print a setup code");
    process.env["E2E_SETUP_CODE"] = code;
    // Copy 2 also lets people who aren't signed in work in their browser (local mode tests).
    server2 = start(PORT_2, BASE_URL_2, { VISITOR_WORKSPACE: "local" });
    server2.stdout?.on("data", keep);
    server2.stderr?.on("data", keep);
    await waitUntilUp(server2, BASE_URL_2);
  } catch (error) {
    server.kill();
    server2?.kill();
    provider.kill();
    await mailpit.stop();
    await database.stop();
    throw new Error(`${(error as Error).message}\n--- server output ---\n${output}`);
  }

  const staticServer = serveLocalBuild();

  return async () => {
    staticServer.close();
    await Promise.all([stop(server), stop(server2!)]);
    provider.kill();
    await mailpit.stop();
    await database.stop();
  };
}

async function stop(server: ChildProcess): Promise<void> {
  server.kill("SIGTERM");
  await new Promise((resolve) => (server.exitCode !== null ? resolve(null) : server.once("exit", resolve)));
}

async function waitUntilUp(server: ChildProcess, baseUrl: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`The server exited (code ${server.exitCode})`);
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The server didn't start within 90 s");
}

const LOCAL_DIR = join(ROOT, "apps/web/dist-local");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

/** The local-only build on a plain static server (any path that isn't a file gets index.html). */
function serveLocalBuild() {
  return createServer(async (request, response) => {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]!);
    const file = path.startsWith("/assets/") ? join(LOCAL_DIR, path) : join(LOCAL_DIR, "index.html");
    try {
      const body = await readFile(file);
      response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  }).listen(3220, "127.0.0.1");
}
