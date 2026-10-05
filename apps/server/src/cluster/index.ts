import pg from "pg";
import type { Config } from "../config";
import { LocalBus, NoLock } from "./local";
import { PgEventBus, PgLock, type Log } from "./postgres";
import type { Cluster } from "./types";

/** The shared-state pieces for this mode: in memory (single) or through Postgres. */
export async function createCluster(config: Pick<Config, "cluster" | "databaseUrl">, log: Log): Promise<Cluster> {
  if (config.cluster === "single") return { mode: "single", bus: new LocalBus(), lock: new NoLock(), close: async () => undefined };
  if (!config.databaseUrl) throw new Error("CLUSTER=postgres needs DATABASE_URL");
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 10_000, application_name: "ganttlines-cluster" });
  pool.on("error", (error) => log("cluster: pooled connection failed", error));
  const bus = new PgEventBus(config.databaseUrl, pool, log);
  await bus.start();
  return {
    mode: "postgres",
    bus,
    lock: new PgLock(pool),
    close: async () => {
      await bus.close();
      await pool.end();
    },
  };
}
