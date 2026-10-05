import pg from "pg";

/** Advisory lock key (two-int form) held while a copy checks for, backs up before and runs migrations. */
const STARTUP: [number, number] = [7101, 1];

/**
 * Runs `work` while holding the start-up lock: when several copies start at once after an upgrade,
 * the first backs up and migrates; the others wait, then find nothing left to do.
 */
export async function withStartupLock<T>(databaseUrl: string, work: () => Promise<T>, log: (message: string) => void = () => undefined): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl, application_name: "ganttlines-startup" });
  client.on("error", () => undefined); // a dropped connection releases the lock; `work` reports its own errors
  await client.connect();
  try {
    const { rows } = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1, $2) AS ok", STARTUP);
    if (!rows[0]?.ok) {
      log("Another copy is starting up (checking for database updates); waiting…");
      await client.query("SELECT pg_advisory_lock($1, $2)", STARTUP);
    }
    return await work();
  } finally {
    await client.end().catch(() => undefined);
  }
}
