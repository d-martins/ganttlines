import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { prismaDatabaseUrl, withDatabaseCa } from "../../src/maintenance/database-ca";
import { libpqEnv } from "../../src/maintenance/postgres";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n";
const URL_ = "postgresql://u:p@db.example.com:25060/defaultdb?sslmode=require";
const dir = () => mkdtempSync(join(tmpdir(), "gl-ca-"));

describe("a managed database's certificate authority (DATABASE_CA_CERT)", () => {
  it("changes nothing when unset", () => {
    expect(withDatabaseCa(URL_, undefined)).toBe(URL_);
    expect(withDatabaseCa(URL_, "  ")).toBe(URL_);
  });

  it("writes the certificate to a private file and points the URL at it", () => {
    const url = new URL(withDatabaseCa(URL_, PEM, dir()));
    const file = url.searchParams.get("sslrootcert")!;
    expect(readFileSync(file, "utf8")).toBe(PEM);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(url.searchParams.get("sslmode")).toBe("require");
  });

  it("normalizes whitespace and Windows line endings from a pasted value", () => {
    const file = new URL(withDatabaseCa(URL_, `\r\n  ${PEM.replace(/\n/g, "\r\n")}  `, dir())).searchParams.get("sslrootcert")!;
    expect(readFileSync(file, "utf8")).toBe(PEM);
  });

  it("uses the same file for the same certificate (restarts, several processes)", () => {
    const where = dir();
    expect(withDatabaseCa(URL_, PEM, where)).toBe(withDatabaseCa(URL_, PEM, where));
  });

  it("leaves an explicit sslrootcert, and a connection without TLS, alone", () => {
    const explicit = `${URL_}&sslrootcert=/etc/ca.pem`;
    expect(withDatabaseCa(explicit, PEM, dir())).toBe(explicit);
    const plain = "postgresql://u:p@db/x?sslmode=disable";
    expect(withDatabaseCa(plain, PEM, dir())).toBe(plain);
  });

  it("refuses something that isn't a PEM certificate", () => {
    expect(() => withDatabaseCa(URL_, "not a certificate", dir())).toThrow(/DATABASE_CA_CERT/);
  });

  it("is applied by the server's settings", () => {
    const config = loadConfig({ DATABASE_URL: URL_, SESSION_SECRET: "x".repeat(32), DATABASE_CA_CERT: PEM });
    expect(new URL(config.databaseUrl).searchParams.get("sslrootcert")).toMatch(/\.pem$/);
  });

  it("reaches the backup tools and Prisma's migrations", () => {
    const withCa = withDatabaseCa(URL_, PEM, dir());
    const file = new URL(withCa).searchParams.get("sslrootcert");
    expect(libpqEnv(withCa)).toMatchObject({ PGSSLMODE: "require", PGSSLROOTCERT: file });
    const prisma = new URL(prismaDatabaseUrl(withCa));
    expect(prisma.searchParams.get("sslrootcert")).toBeNull();
    expect(prisma.searchParams.get("sslcert")).toBe(file);
    expect(prisma.searchParams.get("sslaccept")).toBe("strict");
    expect(prismaDatabaseUrl(URL_)).toBe(URL_);
  });
});
