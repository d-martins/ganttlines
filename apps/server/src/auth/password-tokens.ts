import { createHash, randomBytes } from "node:crypto";
import type { Db } from "@ganttlines/db";

export type TokenPurpose = "reset" | "invite";

const LIFETIME: Record<TokenPurpose, number> = { reset: 60 * 60 * 1000, invite: 7 * 24 * 60 * 60 * 1000 };
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * One-time links for choosing a password (invitations, "forgot password"). Only a hash is stored;
 * a link works once, until it expires, and a newer link replaces older ones.
 */
export class PasswordTokens {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issue(userId: string, purpose: TokenPurpose): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.db.$transaction([
      this.db.passwordToken.deleteMany({ where: { userId } }),
      this.db.passwordToken.create({ data: { userId, purpose, tokenHash: digest(token), expiresAt: new Date(this.now().getTime() + LIFETIME[purpose]) } }),
    ]);
    return token;
  }

  /** The account a still-valid link belongs to — using it up — or null. */
  async redeem(token: string): Promise<string | null> {
    const found = await this.db.passwordToken.findUnique({ where: { tokenHash: digest(token) } });
    if (!found) return null;
    await this.db.passwordToken.deleteMany({ where: { userId: found.userId } });
    return found.expiresAt > this.now() ? found.userId : null;
  }
}
