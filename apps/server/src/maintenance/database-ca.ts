import { createHash } from "node:crypto";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Managed PostgreSQL services (DigitalOcean, AWS, Azure …) sign their certificate with their own
 * authority. With its certificate in DATABASE_CA_CERT the connection is verified against it: the PEM
 * is written to a private file named after its content, and the URL points at it (`sslrootcert`),
 * which `pg`, libpq tools and (translated) Prisma all understand.
 */
export function withDatabaseCa(databaseUrl: string, pem: string | undefined, dir = tmpdir()): string {
  const text = pem?.replace(/\r\n/g, "\n").trim();
  if (!text) return databaseUrl;
  if (!/^-----BEGIN CERTIFICATE-----\n[\s\S]+\n-----END CERTIFICATE-----$/.test(text)) {
    throw new Error("DATABASE_CA_CERT must be a PEM certificate (-----BEGIN CERTIFICATE----- …)");
  }
  const url = new URL(databaseUrl);
  if (url.searchParams.has("sslrootcert") || url.searchParams.get("sslmode") === "disable") return databaseUrl;
  const content = `${text}\n`;
  const file = join(dir, `ganttlines-db-ca-${createHash("sha256").update(content).digest("hex").slice(0, 16)}.pem`);
  if (!existsSync(file)) {
    // Written aside and renamed: another process never reads half a file.
    const partial = `${file}.${process.pid}.tmp`;
    writeFileSync(partial, content, { mode: 0o600 });
    renameSync(partial, file);
  }
  url.searchParams.set("sslrootcert", file);
  return url.toString();
}

/** Prisma's migrate engine names the authority file `sslcert` and verifies only with `sslaccept=strict`. */
export function prismaDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const file = url.searchParams.get("sslrootcert");
  if (!file) return databaseUrl;
  url.searchParams.delete("sslrootcert");
  url.searchParams.set("sslcert", file);
  url.searchParams.set("sslaccept", "strict");
  return url.toString();
}
