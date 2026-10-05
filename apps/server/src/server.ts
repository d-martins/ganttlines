import { createDb } from "@ganttlines/db";
import { buildApp } from "./app";
import { holdModeGuard } from "./cluster/mode-guard";
import type { Config } from "./config";

/** Starts the HTTP/WebSocket server and closes it cleanly on SIGINT/SIGTERM. */
export async function startServer(config: Config): Promise<void> {
  // Copies sharing a database must agree on CLUSTER (single mode can't coordinate with others).
  const guard = await holdModeGuard(config.databaseUrl, config.cluster);
  const db = createDb(config.databaseUrl);
  const announce = (message: string) => console.log(`[ganttlines] ${message}`);
  const app = await buildApp({ db, config, logger: true, announce });

  const shutdown = async () => {
    await app.close();
    await db.$disconnect();
    await guard.release().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ host: config.bind, port: config.port });
}
