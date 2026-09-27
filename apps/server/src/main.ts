import { createDb } from "@ganttlines/db";
import { buildApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig(process.env);
const db = createDb(config.databaseUrl);
const app = await buildApp({ db, config, logger: true });

const shutdown = async () => {
  await app.close();
  await db.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host: config.bind, port: config.port });
