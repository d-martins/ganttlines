import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The certificate files this process wrote, by folder and content. */
const written = new Map<string, string>();

/**
 * Managed PostgreSQL services (DigitalOcean, AWS, Azure …) sign their certificate with their own
 * authority. With its certificate in DATABASE_CA_CERT the connection is verified against it: the PEM
 * is written to a private file (once per process), and the URL points at it (`sslrootcert`), which
 * `pg`, libpq tools and (translated) Prisma all understand.
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
  const key = `${dir}\0${content}`;
  let file = written.get(key);
  if (!file) {
    // A folder only this process can use: a file someone else left in the shared temporary
    // folder is never trusted.
    file = join(mkdtempSync(join(dir, "ganttlines-db-ca-")), "ca.pem");
    writeFileSync(file, content, { mode: 0o600, flag: "wx" });
    written.set(key, file);
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
