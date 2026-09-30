import { loadConfig } from "./config";
import { startServer } from "./server";

// Development entry (tsx watch): serves without the migrate step — use `yarn workspace @ganttlines/db migrate:dev`.
await startServer(loadConfig(process.env));
