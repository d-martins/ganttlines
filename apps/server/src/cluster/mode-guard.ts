import pg from "pg";

/** Advisory lock key (two-int form) every GanttLines process holds while it runs. */
const GUARD: [number, number] = [7101, 0];

export class ModeGuardError extends Error {}

/**
 * Makes sure copies sharing one database agree on CLUSTER: a single-mode server holds the guard
 * exclusively, postgres-mode copies share it. Held until `release()` (or the process ends).
 */
export async function holdModeGuard(databaseUrl: string, mode: "single" | "postgres"): Promise<{ release(): Promise<void> }> {
  const client = new pg.Client({ connectionString: databaseUrl, application_name: "ganttlines-guard" });
  await client.connect();
  const exclusive = mode === "single";
  const fn = exclusive ? "pg_try_advisory_lock" : "pg_try_advisory_lock_shared";
  const { rows } = await client.query<{ ok: boolean }>(`SELECT ${fn}($1, $2) AS ok`, GUARD);
  if (rows[0]?.ok) return { release: () => client.end() };
  // Who holds it? A shared holder means postgres-mode copies; otherwise a single-mode server.
  const held = await client.query<{ shared: boolean | null }>(
    "SELECT bool_or(mode = 'ShareLock') AS shared FROM pg_locks WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND objsubid = 2 AND granted",
    GUARD,
  );
  await client.end();
  if (exclusive && held.rows[0]?.shared === true) {
    throw new ModeGuardError("Several GanttLines servers are using this database. Set CLUSTER=postgres on all of them (or run just one).");
  }
  throw new ModeGuardError(
    exclusive
      ? "Another GanttLines server is already using this database. To run several copies, set CLUSTER=postgres on all of them."
      : "A GanttLines server in single mode is already using this database. Stop it, or set CLUSTER=postgres on it too.",
  );
}
