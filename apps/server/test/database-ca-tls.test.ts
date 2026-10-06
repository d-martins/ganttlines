import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withDatabaseCa } from "../src/maintenance/database-ca";
import { migrate, migrationStatus } from "../src/maintenance/maintenance";
import { withClient } from "../src/maintenance/postgres";

let container: StartedTestContainer;
let url: string;
let ca: string;

function certificates(): string {
  const dir = mkdtempSync(join(tmpdir(), "gl-tls-"));
  const ssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "san.ext"), "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n");
  ssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=Test CA", "-keyout", "ca.key", "-out", "ca.crt");
  ssl("req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", "server.key", "-out", "server.csr");
  ssl("x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-out", "server.crt", "-extfile", "san.ext");
  return dir;
}

beforeAll(async () => {
  const dir = certificates();
  ca = readFileSync(join(dir, "ca.crt"), "utf8");
  container = await new GenericContainer("postgres:17")
    .withEnvironment({ POSTGRES_PASSWORD: "test", POSTGRES_DB: "ganttlines" })
    .withCopyFilesToContainer([
      { source: join(dir, "server.crt"), target: "/tls/server.crt" },
      { source: join(dir, "server.key"), target: "/tls/server.key" },
    ])
    .withEntrypoint(["sh", "-c",
      "install -o postgres -m 600 /tls/server.key /var/lib/postgresql/server.key && install -o postgres -m 644 /tls/server.crt /var/lib/postgresql/server.crt && " +
      "exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/var/lib/postgresql/server.crt -c ssl_key_file=/var/lib/postgresql/server.key"])
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  url = `postgresql://postgres:test@localhost:${container.getMappedPort(5432)}/ganttlines?sslmode=require`;
}, 120_000);

afterAll(async () => {
  await container?.stop();
});

describe("a database whose certificate comes from its own authority", () => {
  it("can't be reached without the authority (the managed-database problem)", async () => {
    await expect(withClient(url, (client) => client.query("SELECT 1"))).rejects.toThrow(/self[- ]signed|certificate/i);
  });

  it("is reached, and migrated, with DATABASE_CA_CERT", async () => {
    const verified = withDatabaseCa(url, ca);
    await expect(withClient(verified, async (client) => (await client.query("SELECT 1 AS one")).rows[0].one)).resolves.toBe(1);
    await migrate(verified);
    expect((await migrationStatus(verified)).pending).toEqual([]);
  }, 120_000);
});
