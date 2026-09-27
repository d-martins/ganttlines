import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

/** Starts a throwaway Postgres (requires Docker) and applies the Prisma migrations to it. */
export async function setup(project: TestProject): Promise<void> {
  container = await new PostgreSqlContainer("postgres:17").start();
  const databaseUrl = container.getConnectionUri();
  execFileSync("yarn", ["prisma", "migrate", "deploy"], {
    cwd: fileURLToPath(new URL("../../../packages/db", import.meta.url)),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });
  project.provide("databaseUrl", databaseUrl);
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
