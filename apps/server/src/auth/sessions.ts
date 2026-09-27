import type { Db, User } from "@ganttlines/db";
import { createHmac, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "gp_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sliding expiry is written at most this often per session. */
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export interface ResolvedSession {
  user: User;
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

  async create(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await this.db.session.create({ data: { id: this.digest(token), userId, expiresAt, lastSeenAt: now } });
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
      return { user: session.user, refreshedUntil: null };
    }
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await this.db.session.update({ where: { id }, data: { lastSeenAt: now, expiresAt } });
    return { user: session.user, refreshedUntil: expiresAt };
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
