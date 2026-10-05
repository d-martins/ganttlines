import pg from "pg";
import type { Config } from "../config";
import { LocalBus, NoLock } from "./local";
import { PgEventBus, PgLock, type Log } from "./postgres";
import type { Cluster } from "./types";

/** The shared-state pieces for this mode: in memory (single) or through Postgres. */
export async function createCluster(config: Pick<Config, "cluster" | "databaseUrl">, log: Log): Promise<Cluster> {
  if (config.cluster === "single") return { mode: "single", bus: new LocalBus(), lock: new NoLock(), close: async () => undefined };
  if (!config.databaseUrl) throw new Error("CLUSTER=postgres needs DATABASE_URL");
  // Locks and notifications get their own connections, so busy locks never hold up notifications.
  const pool = (name: string, max: number) => {
    const created = new pg.Pool({ connectionString: config.databaseUrl, max, connectionTimeoutMillis: 10_000, application_name: name });
    created.on("error", (error) => log("cluster: pooled connection failed", error));
    return created;
  };
  const locks = pool("ganttlines-locks", 8);
  const notices = pool("ganttlines-notices", 2);
  const bus = new PgEventBus(config.databaseUrl, notices, log);
  await bus.start();
  return {
    mode: "postgres",
    bus,
    lock: new PgLock(locks),
    close: async () => {
      await bus.close();
      await Promise.all([locks.end(), notices.end()]);
    },
  };
}
