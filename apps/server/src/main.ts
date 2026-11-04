import { loadConfig } from "./config";
import { startServer } from "./server";

// Development entry (tsx watch): `yarn start` applies migrations first; changing the schema takes `yarn workspace @ganttlines/db migrate:dev`.
await startServer(loadConfig(process.env));
