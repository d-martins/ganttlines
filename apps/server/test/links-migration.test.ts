import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATIONS = fileURLToPath(new URL("../../../packages/db/prisma/migrations/", import.meta.url));
const LINKS = "20261018120000_links";

let container: StartedPostgreSqlContainer;
let client: Client;

const sql = (name: string) => readFileSync(`${MIGRATIONS}${name}/migration.sql`, "utf8");

const project = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const id = (n: number) => `10000000-0000-4000-8000-00000000000${n}`;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17").start();
  client = new Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  const names = readdirSync(MIGRATIONS).filter((name) => /^\d+_/.test(name)).sort();
  expect(names).toContain(LINKS);
  for (const name of names.filter((name) => name < LINKS)) await client.query(sql(name));

  await client.query(`INSERT INTO "Project" (id, name) VALUES ($1, 'A'), ($2, 'B')`, [project, other]);
  const row = (rowId: string, projectId: string, predecessorId: string | null, offset: number) =>
    client.query(
      `INSERT INTO "Row" (id, "projectId", kind, title, position, "predecessorId", "offset") VALUES ($1, $2, 'task', 't', 'a0', $3, $4)`,
      [rowId, projectId, predecessorId, offset],
    );
  await row(id(1), project, null, 0);
  await row(id(2), project, id(1), -1.5);
  await row(id(3), project, id(1), 0);
  await row(id(4), project, id(9), 2); // the predecessor does not exist
  await row(id(5), other, id(1), 1); // the predecessor is in another project
  await row(id(6), project, null, 3); // an offset without a predecessor
  await row(id(7), project, id(7), 1); // names itself

  await client.query(sql(LINKS));
}, 120_000);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

describe("20261018120000_links", () => {
  it("turns each resolvable predecessor into a finish-to-start link carrying the offset as lag", async () => {
    const { rows } = await client.query(`SELECT "projectId", "predecessorId", "followerId", kind, lag FROM "Link" ORDER BY "followerId"`);
    expect(rows).toEqual([
      { projectId: project, predecessorId: id(1), followerId: id(2), kind: "FS", lag: -1.5 },
      { projectId: project, predecessorId: id(1), followerId: id(3), kind: "FS", lag: 0 },
    ]);
  });

  it("drops the old columns", async () => {
    const { rows } = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'Row'`);
    const names = rows.map((r) => r.column_name);
    expect(names).not.toContain("predecessorId");
    expect(names).not.toContain("offset");
  });

  it("deletes a task's links with the task", async () => {
    await client.query(`DELETE FROM "Row" WHERE id = $1`, [id(2)]);
    const { rows } = await client.query(`SELECT "followerId" FROM "Link"`);
    expect(rows).toEqual([{ followerId: id(3) }]);
  });
});
