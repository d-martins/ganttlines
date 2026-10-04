import type { Db, OAuthClient } from "@ganttlines/db";
import { lookup } from "node:dns/promises";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";

/** An OAuth error, answered as `{ error, error_description }` (or put on the redirect). */
export class OAuthFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Fetches a client metadata document (tests pass a fake). */
export type MetadataFetcher = (url: URL) => Promise<unknown>;

/** Metadata documents are fetched again after a day. */
const METADATA_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_REDIRECT_URIS = 10;
/** Schemes an app can't use to receive the code: http only for this computer's own address (below). */
const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "ftp:", "ws:", "wss:"]);

/**
 * Where an app may receive its code: an https URL, this computer's own address over http (desktop
 * apps listening locally), or an app's own scheme (e.g. `cursor://…`); never with a fragment.
 */
export function isAllowedRedirect(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || value.length > 2000) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !FORBIDDEN_SCHEMES.has(url.protocol);
}

/**
 * Loopback redirects match on everything but the port (desktop apps pick a free port each time);
 * all others must match exactly.
 */
export function redirectMatches(registered: string, given: string): boolean {
  if (registered === given) return true;
  try {
    const [a, b] = [new URL(registered), new URL(given)];
    const loopback = a.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(a.hostname);
    return loopback && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search && b.protocol === "http:";
  } catch {
    return false;
  }
}

function cleanName(name: unknown, fallback: string): string {
  const text = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100) : "";
  return text || fallback;
}

function redirectList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REDIRECT_URIS) {
    throw new OAuthFailure("invalid_redirect_uri", "redirect_uris must list 1–10 addresses");
  }
  for (const uri of value) {
    if (typeof uri !== "string" || !isAllowedRedirect(uri)) {
      throw new OAuthFailure("invalid_redirect_uri", `Not an allowed redirect address: ${String(uri).slice(0, 200)}`);
    }
  }
  return value as string[];
}

/** Refuses addresses inside private networks, so a metadata URL can't make the server probe them. */
function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224);
  }
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) return isPublicAddress(lower.slice(7));
  return !(lower === "::1" || lower === "::" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb") || lower.startsWith("ff"));
}

/** The real fetcher: public https addresses only, small JSON, a few seconds at most, no redirects. */
export const fetchMetadata: MetadataFetcher = async (url) => {
  const addresses = await lookup(url.hostname, { all: true });
  if (addresses.length === 0 || !addresses.every(({ address }) => isPublicAddress(address))) {
    throw new OAuthFailure("invalid_client", "The app's metadata address isn't public");
  }
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
  if (!response.ok) throw new OAuthFailure("invalid_client", `The app's metadata answered ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_METADATA_BYTES) throw new OAuthFailure("invalid_client", "The app's metadata is too large");
  return JSON.parse(text) as unknown;
};

/**
 * The AI apps people can connect: ones that registered themselves (dynamic client registration),
 * and ones whose client id is the https address of their metadata document (fetched, then kept for
 * a day).
 */
export class OAuthClients {
  constructor(
    private readonly db: Db,
    private readonly fetcher: MetadataFetcher,
    private readonly now: () => Date,
  ) {}

  /** Dynamic client registration (RFC 7591): public clients only, authorization code + refresh. */
  async register(body: unknown): Promise<Record<string, unknown>> {
    const metadata = (body ?? {}) as Record<string, unknown>;
    const redirectUris = redirectList(metadata["redirect_uris"]);
    const method = metadata["token_endpoint_auth_method"];
    if (method !== undefined && method !== "none") {
      throw new OAuthFailure("invalid_client_metadata", "Only public clients (token_endpoint_auth_method none) can register");
    }
    const client = await this.db.oAuthClient.create({
      data: { id: `app_${randomBytes(16).toString("base64url")}`, name: cleanName(metadata["client_name"], "An AI app"), redirectUris },
    });
    return {
      client_id: client.id,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  /** The app behind `clientId`, fetching (or refreshing) its metadata document when it's a URL. */
  async find(clientId: string): Promise<OAuthClient> {
    if (!clientId.startsWith("https://")) {
      const client = await this.db.oAuthClient.findUnique({ where: { id: clientId } });
      if (!client || client.fromMetadata) throw new OAuthFailure("invalid_client", "Unknown app");
      return client;
    }
    const known = await this.db.oAuthClient.findUnique({ where: { id: clientId } });
    if (known?.fetchedAt && this.now().getTime() - known.fetchedAt.getTime() < METADATA_TTL_MS) return known;
    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      throw new OAuthFailure("invalid_client", "The app's id isn't a valid address");
    }
    if (url.pathname === "/" || url.hash || url.username || url.password || clientId.length > 2000) {
      throw new OAuthFailure("invalid_client", "The app's id must be the https address of its metadata document");
    }
    let document: Record<string, unknown>;
    try {
      document = (await this.fetcher(url)) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof OAuthFailure) throw error;
      throw new OAuthFailure("invalid_client", "Couldn't read the app's metadata");
    }
    if (document?.["client_id"] !== clientId) throw new OAuthFailure("invalid_client", "The app's metadata names another client id");
    const data = {
      name: cleanName(document["client_name"], url.hostname),
      redirectUris: redirectList(document["redirect_uris"]),
      fromMetadata: true,
      fetchedAt: this.now(),
    };
    return this.db.oAuthClient.upsert({ where: { id: clientId }, create: { id: clientId, ...data }, update: data });
  }

  /** Registered apps nobody connected within 30 days. */
  async deleteUnused(): Promise<number> {
    const before = new Date(this.now().getTime() - 30 * 24 * 60 * 60 * 1000);
    const { count } = await this.db.oAuthClient.deleteMany({ where: { createdAt: { lt: before }, connections: { none: {} } } });
    return count;
  }
}
