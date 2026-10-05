import pg from "pg";

/** Advisory lock key (two-int form) every GanttLines process holds while it runs. */
const GUARD: [number, number] = [7101, 0];

export class ModeGuardError extends Error {}

export interface ModeGuardOptions {
  /** how long to keep trying while another server holds the guard (deploys that start the new one first) */
  waitMs?: number;
  retryMs?: number;
  log?: (message: string) => void;
  /** the guard was lost for good (another server took it while this one's connection was down) */
  onLost?: (error: Error) => void;
}

/**
 * Makes sure copies sharing one database agree on CLUSTER: a single-mode server holds the guard
 * exclusively, postgres-mode copies share it. Held until `release()`; if its connection drops (the
 * database restarted) it is taken again in the background.
 */
export async function holdModeGuard(
  databaseUrl: string,
  mode: "single" | "postgres",
  { waitMs = 0, retryMs = 3000, log = () => undefined, onLost = () => undefined }: ModeGuardOptions = {},
): Promise<{ release(): Promise<void> }> {
  let client: pg.Client | null = null;
  let released = false;

  const take = async (deadline: number): Promise<pg.Client> => {
    for (let waited = false; ; waited = true) {
      const attempt = new pg.Client({ connectionString: databaseUrl, application_name: "ganttlines-guard", keepAlive: true });
      // A dropped connection must never crash the server; it's noticed through "end".
      attempt.on("error", () => undefined);
      await attempt.connect();
      const problem = await tryGuard(attempt, mode);
      if (!problem) return attempt;
      await attempt.end().catch(() => undefined);
      if (Date.now() >= deadline) throw problem;
      if (!waited) log("Waiting for the other GanttLines server using this database to stop…");
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  };

  const watch = (held: pg.Client) => {
    held.on("end", () => {
      if (released || client !== held) return;
      client = null;
      log("Lost the database connection holding the server guard; taking it again…");
      const retake = (): void => {
        if (released) return;
        take(Date.now() + 60_000).then(
          (again) => {
            if (released) return void again.end().catch(() => undefined);
            client = again;
            watch(again);
          },
          (error: unknown) => {
            if (error instanceof ModeGuardError) return onLost(error);
            setTimeout(retake, retryMs).unref(); // the database is still down
          },
        );
      };
      setTimeout(retake, retryMs).unref();
    });
  };

  client = await take(Date.now() + waitMs);
  watch(client);
  return {
    release: async () => {
      released = true;
      await client?.end().catch(() => undefined);
    },
  };
}

/** Takes the guard on `client`, or says why it can't. */
async function tryGuard(client: pg.Client, mode: "single" | "postgres"): Promise<ModeGuardError | null> {
  const exclusive = mode === "single";
  const fn = exclusive ? "pg_try_advisory_lock" : "pg_try_advisory_lock_shared";
  const { rows } = await client.query<{ ok: boolean }>(`SELECT ${fn}($1, $2) AS ok`, GUARD);
  if (rows[0]?.ok) return null;
  // Who holds it? A shared holder means postgres-mode copies; otherwise a single-mode server.
  const held = await client.query<{ shared: boolean | null }>(
    "SELECT bool_or(mode = 'ShareLock') AS shared FROM pg_locks WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND objsubid = 2 AND granted",
    GUARD,
  );
  if (exclusive && held.rows[0]?.shared === true) {
    return new ModeGuardError("Several GanttLines servers are using this database. Set CLUSTER=postgres on all of them (or run just one).");
  }
  return new ModeGuardError(
    exclusive
      ? "Another GanttLines server is already using this database. To run several copies, set CLUSTER=postgres on all of them."
      : "A GanttLines server in single mode is already using this database. Stop it, or set CLUSTER=postgres on it too.",
  );
}
