import { loadConfig } from "./config";
import { backup, migrate, migrationStatus, restore } from "./maintenance/maintenance";
import { waitForDatabase } from "./maintenance/postgres";
import { withStartupLock } from "./maintenance/startup-lock";
import { startServer } from "./server";

/**
 * The image's entry point:
 *   start            wait for the database, back it up if migrations are pending, migrate, serve (default)
 *   backup           dump the database into BACKUP_DIR
 *   restore <file>   replace the database with a backup (stop the app first)
 *   migrate          apply pending migrations only
 *   version          print the version
 */
const VERSION = process.env["APP_VERSION"] || "dev";
const BACKUP_DIR = process.env["BACKUP_DIR"] || "/backups";
const log = (message: string) => console.log(`[ganttlines] ${message}`);

function databaseUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is required");
  return url;
}

async function start(): Promise<void> {
  const config = loadConfig(process.env); // fail fast on a missing secret, before touching the database
  log(`version ${VERSION}`);
  await waitForDatabase(config.databaseUrl, 60_000, log);
  // Several copies may start at once after an upgrade: one checks, backs up and migrates at a time.
  await withStartupLock(
    config.databaseUrl,
    async () => {
      const { pending, fresh } = await migrationStatus(config.databaseUrl);
      if (pending.length > 0) {
        let saved: string | null = null;
        if (!fresh && process.env["BACKUP_BEFORE_MIGRATE"] !== "false") {
          log(`${pending.length} database migration(s) to apply; backing up first…`);
          try {
            saved = await backup(config.databaseUrl, BACKUP_DIR, `before-${VERSION}`);
          } catch (error) {
            throw new Error(
              `The backup before migrating failed, so nothing was changed: ${(error as Error).message}\n` +
                "Fix the cause (e.g. BACKUP_DIR not writable), or set BACKUP_BEFORE_MIGRATE=false to migrate without a backup.",
            );
          }
          log(`Backup saved: ${saved}`);
        }
        try {
          await migrate(config.databaseUrl);
        } catch (error) {
          throw new Error(
            `Migrating the database failed: ${(error as Error).message}\n` +
              (saved
                ? `To go back: run the previous version's image with \`restore ${saved}\`, then start that version again.`
                : "Nothing was backed up before migrating (a new database, or BACKUP_BEFORE_MIGRATE=false)."),
          );
        }
        log("Database is up to date.");
      }
    },
    log,
  );
  await startServer(config);
}

async function main(argv: string[]): Promise<void> {
  const [command = "start", ...args] = argv;
  switch (command) {
    case "start":
      return start();
    case "backup":
      log(`Backup saved: ${await backup(databaseUrl(), BACKUP_DIR, args[0] ?? "")}`);
      return;
    case "restore": {
      const file = args[0];
      if (!file) throw new Error("Usage: restore <backup file>");
      await restore(databaseUrl(), file);
      log(`Restored ${file}. Start the app with the version that made this backup, or a newer one.`);
      return;
    }
    case "migrate":
      await migrate(databaseUrl());
      return;
    case "version":
      console.log(VERSION);
      return;
    default:
      throw new Error(`Unknown command "${command}". Commands: start, backup, restore <file>, migrate, version`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`[ganttlines] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
