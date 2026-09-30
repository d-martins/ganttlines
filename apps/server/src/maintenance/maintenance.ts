import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { libpqEnv, pgTool, run, serverMajor, withClient } from "./postgres";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const DB_PACKAGE = join(ROOT, "packages/db");
export const MIGRATIONS_DIR = join(DB_PACKAGE, "prisma/migrations");

export interface MigrationStatus {
  /** migrations shipped with this version that the database hasn't applied, oldest first */
  pending: string[];
  /** no migration has ever been applied: a new, empty database */
  fresh: boolean;
}

/** Compares the migrations shipped with this version against the ones the database has applied. */
export async function migrationStatus(databaseUrl: string, migrationsDir = MIGRATIONS_DIR): Promise<MigrationStatus> {
  const shipped = (await readdir(migrationsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return withClient(databaseUrl, async (client) => {
    const table = await client.query("SELECT to_regclass('public._prisma_migrations') AS name");
    if (!table.rows[0].name) return { pending: shipped, fresh: true };
    const applied = await client.query("SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL");
    const done = new Set(applied.rows.map((row: { migration_name: string }) => row.migration_name));
    return { pending: shipped.filter((name) => !done.has(name)), fresh: done.size === 0 };
  });
}

/** "2026-09-30T18-04-05Z" — sortable and safe in file names. */
export const stamp = (date: Date) => date.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");

/**
 * Dumps the whole database (pg_dump custom format) into `dir` and returns the file's path:
 * ganttlines-<time>[-<label>].dump.
 */
export async function backup(databaseUrl: string, dir: string, label = "", now = new Date()): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, `ganttlines-${stamp(now)}${label ? `-${label.replace(/[^\w.-]+/g, "_")}` : ""}.dump`);
  const tool = pgTool("pg_dump", await serverMajor(databaseUrl));
  await run(tool, ["--format=custom", "--no-owner", "--no-privileges", `--file=${file}`], libpqEnv(databaseUrl));
  return file;
}

/** Replaces the database's contents with a backup (the app must be stopped). */
export async function restore(databaseUrl: string, file: string): Promise<void> {
  const tool = pgTool("pg_restore", await serverMajor(databaseUrl));
  const env = libpqEnv(databaseUrl);
  await run(tool, ["--clean", "--if-exists", "--no-owner", "--no-privileges", "--single-transaction", `--dbname=${env["PGDATABASE"]}`, file], env);
}

/** Applies pending migrations (prisma migrate deploy). */
export async function migrate(databaseUrl: string): Promise<void> {
  await run(join(ROOT, "node_modules/.bin/prisma"), ["migrate", "deploy"], { DATABASE_URL: databaseUrl }, DB_PACKAGE);
}
