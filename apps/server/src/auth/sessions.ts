import type { Db, User } from "@ganttlines/db";
import { createHmac, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "gp_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sliding expiry is written at most this often per session. */
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export interface ResolvedSession {
  user: User;
  /** signed in with single sign-on rather than a password */
  viaSso: boolean;
  /** New expiry when the session was extended by this request (the cookie should be re-sent). */
  refreshedUntil: Date | null;
}

/** DB-backed sessions with 30-day sliding expiry. Only an HMAC of each token is stored. */
export class SessionStore {
  constructor(
    private readonly db: Db,
    private readonly secret: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(userId: string, { viaSso = false } = {}): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await this.db.session.create({ data: { id: this.digest(token), userId, expiresAt, lastSeenAt: now, viaSso } });
    return { token, expiresAt };
  }

  async resolve(token: string): Promise<ResolvedSession | null> {
    const id = this.digest(token);
    const session = await this.db.session.findUnique({ where: { id }, include: { user: true } });
    if (!session) return null;
    const now = this.now();
    if (session.expiresAt <= now) {
      await this.db.session.deleteMany({ where: { id } });
      return null;
    }
    if (now.getTime() - session.lastSeenAt.getTime() < REFRESH_INTERVAL_MS) {
      return { user: session.user, viaSso: session.viaSso, refreshedUntil: null };
    }
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    // updateMany: the session may have been revoked concurrently (e.g. logout in another tab).
    const { count } = await this.db.session.updateMany({ where: { id }, data: { lastSeenAt: now, expiresAt } });
    if (count === 0) return null;
    return { user: session.user, viaSso: session.viaSso, refreshedUntil: expiresAt };
  }

  /** The live sessions among `tokens` (read only: checking doesn't extend them), in one query. */
  async check(tokens: string[]): Promise<Map<string, ResolvedSession>> {
    const byDigest = new Map(tokens.map((token) => [this.digest(token), token]));
    const sessions = await this.db.session.findMany({ where: { id: { in: [...byDigest.keys()] }, expiresAt: { gt: this.now() } }, include: { user: true } });
    return new Map(sessions.map((session) => [byDigest.get(session.id)!, { user: session.user, viaSso: session.viaSso, refreshedUntil: null }]));
  }

  /** Removes sessions that expired without being presented again; returns how many. */
  async deleteExpired(): Promise<number> {
    const { count } = await this.db.session.deleteMany({ where: { expiresAt: { lte: this.now() } } });
    return count;
  }

  async revoke(token: string): Promise<void> {
    await this.db.session.deleteMany({ where: { id: this.digest(token) } });
  }

  /** Revokes every session of the user, optionally keeping the one identified by `exceptToken`. */
  async revokeAllForUser(userId: string, exceptToken?: string): Promise<void> {
    const keep = exceptToken === undefined ? undefined : this.digest(exceptToken);
    await this.db.session.deleteMany({ where: { userId, ...(keep ? { NOT: { id: keep } } : {}) } });
  }

  private digest(token: string): string {
    return createHmac("sha256", this.secret).update(token).digest("hex");
  }
}
