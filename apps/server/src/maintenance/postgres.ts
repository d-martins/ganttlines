import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import pg from "pg";

/** Where the Debian/PGDG PostgreSQL client packages install their tools, one folder per major version. */
const PG_LIB = "/usr/lib/postgresql";

/**
 * libpq environment for a connection URL, so tools like pg_dump never see the password on their
 * command line (where other processes could read it).
 */
export function libpqEnv(databaseUrl: string): Record<string, string> {
  const url = new URL(databaseUrl);
  const env: Record<string, string> = {
    PGHOST: decodeURIComponent(url.hostname),
    PGPORT: url.port || "5432",
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")),
  };
  if (url.username) env["PGUSER"] = decodeURIComponent(url.username);
  if (url.password) env["PGPASSWORD"] = decodeURIComponent(url.password);
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode) env["PGSSLMODE"] = sslmode;
  const rootCert = url.searchParams.get("sslrootcert");
  if (rootCert) env["PGSSLROOTCERT"] = rootCert;
  return env;
}

/**
 * The client tool matching the server's major version when installed (dumps from the same major
 * restore cleanly), otherwise the newest installed one (pg_dump reads older servers), otherwise
 * whatever is on PATH.
 */
export function pgTool(name: "pg_dump" | "pg_restore", serverMajor: number, installed: readonly number[] = installedMajors()): string {
  if (installed.includes(serverMajor)) return `${PG_LIB}/${serverMajor}/bin/${name}`;
  const newest = Math.max(...installed);
  return Number.isFinite(newest) ? `${PG_LIB}/${newest}/bin/${name}` : name;
}

function installedMajors(): number[] {
  if (!existsSync(PG_LIB)) return [];
  return readdirSync(PG_LIB)
    .map(Number)
    .filter((major) => Number.isInteger(major) && existsSync(`${PG_LIB}/${major}/bin/pg_dump`));
}

/** Runs `fn` with a connected client, closing it afterwards. */
export async function withClient<T>(databaseUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** The server's major version (e.g. 17). */
export function serverMajor(databaseUrl: string): Promise<number> {
  return withClient(databaseUrl, async (client) => Math.floor(Number((await client.query("SHOW server_version_num")).rows[0].server_version_num) / 10000));
}

/** Waits until the database accepts connections (it may still be starting), up to `timeoutMs`. */
export async function waitForDatabase(databaseUrl: string, timeoutMs = 60_000, log: (message: string) => void = () => undefined): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    try {
      await withClient(databaseUrl, async (client) => client.query("SELECT 1"));
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw new Error(`The database isn't reachable: ${(error as Error).message}`);
      if (attempt === 1) log("Waiting for the database…");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/** Runs a command, inheriting output; rejects when it fails. */
export function run(command: string, args: readonly string[], env: Record<string, string> = {}, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: { ...process.env, ...env }, cwd });
    child.on("error", reject);
    child.on("exit", (code, signal) => (code === 0 ? resolve() : reject(new Error(`${command} ${signal ? `was stopped (${signal})` : `exited with code ${code}`}`))));
  });
}
