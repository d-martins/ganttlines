import { cpSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, inject, it } from "vitest";
import { MIGRATIONS_DIR, migrationStatus, stamp } from "../src/maintenance/maintenance";
import { libpqEnv, pgTool, withClient } from "../src/maintenance/postgres";
import { withStartupLock } from "../src/maintenance/startup-lock";

describe("migration status", () => {
  it("has nothing pending on a migrated database", async () => {
    expect(await migrationStatus(inject("databaseUrl"))).toEqual({ pending: [], fresh: false });
  });

  it("lists migrations shipped with a newer version, oldest first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gp-migrations-"));
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    mkdirSync(join(dir, "29990102000000_later"));
    mkdirSync(join(dir, "29990101000000_next"));
    expect(await migrationStatus(inject("databaseUrl"), dir)).toEqual({ pending: ["29990101000000_next", "29990102000000_later"], fresh: false });
  });

  it("reports an empty database as fresh, with every migration pending", async () => {
    const url = new URL(inject("databaseUrl"));
    await withClient(url.toString(), (client) => client.query("DROP DATABASE IF EXISTS gp_empty").then(() => client.query("CREATE DATABASE gp_empty")));
    url.pathname = "/gp_empty";
    const shipped = readdirSync(MIGRATIONS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    const status = await migrationStatus(url.toString());
    expect(status.fresh).toBe(true);
    expect(status.pending).toHaveLength(shipped.length);
  });
});

describe("postgres tools", () => {
  it("passes the connection through libpq variables, keeping the password off the command line", () => {
    expect(libpqEnv("postgresql://gantt:p%40ss@db.internal:6543/ganttlines?sslmode=require")).toEqual({
      PGHOST: "db.internal",
      PGPORT: "6543",
      PGDATABASE: "ganttlines",
      PGUSER: "gantt",
      PGPASSWORD: "p@ss",
      PGSSLMODE: "require",
    });
  });

  it("uses the client tools matching the server's version, else the newest installed", () => {
    expect(pgTool("pg_dump", 17, [17, 18])).toBe("/usr/lib/postgresql/17/bin/pg_dump");
    expect(pgTool("pg_restore", 16, [17, 18])).toBe("/usr/lib/postgresql/18/bin/pg_restore");
    expect(pgTool("pg_dump", 17, [])).toBe("pg_dump");
  });

  it("stamps backups with a sortable, file-safe time", () => {
    expect(stamp(new Date("2026-09-30T18:04:05.123Z"))).toBe("2026-09-30T18-04-05Z");
  });
});

describe("start-up lock", () => {
  it("lets one copy at a time check and run migrations", async () => {
    const order: string[] = [];
    const step = (name: string) =>
      withStartupLock(inject("databaseUrl"), async () => {
        order.push(`${name} in`);
        await new Promise((resolve) => setTimeout(resolve, 100));
        order.push(`${name} out`);
      });
    await Promise.all([step("A"), step("B")]);
    expect(order[0]!.slice(0, 1)).toBe(order[1]!.slice(0, 1));
  });
});
