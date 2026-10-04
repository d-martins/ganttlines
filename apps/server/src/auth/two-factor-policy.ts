import type { Db, User } from "@ganttlines/db";
import type { TwoFactorRequirement } from "@ganttlines/protocol";

/**
 * Who must use two-factor to sign in with a password: nobody, admins, or everyone. Single sign-on
 * is exempt (the provider decides). Stored in the settings, and only looked up for people who
 * don't use two-factor yet.
 */
export class TwoFactorPolicy {
  constructor(private readonly db: Db) {}

  async requirement(): Promise<TwoFactorRequirement> {
    return (await this.db.settings.findUnique({ where: { id: 1 }, select: { requireTwoFactor: true } }))?.requireTwoFactor ?? "off";
  }

  async set(requirement: TwoFactorRequirement): Promise<void> {
    await this.db.settings.upsert({ where: { id: 1 }, create: { id: 1, requireTwoFactor: requirement }, update: { requireTwoFactor: requirement } });
  }

  /** Whether `requirement` covers `user` (with their current role). */
  covers(user: Pick<User, "role">, requirement: TwoFactorRequirement): boolean {
    return requirement === "everyone" || (requirement === "admins" && user.role === "admin");
  }

  /** Signed in with a password, covered, and two-factor still off: they must set it up first. */
  async mustSetUp(user: Pick<User, "role" | "totpEnabled">, viaSso: boolean): Promise<boolean> {
    if (viaSso || user.totpEnabled) return false;
    return this.covers(user, await this.requirement());
  }
}
