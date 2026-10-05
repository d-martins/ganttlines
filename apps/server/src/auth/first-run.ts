import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Db, User } from "@ganttlines/db";
import { actorOf } from "../actor";
import { insertResource, type InstanceService } from "../calendar/instance-service";
import { conflict } from "../errors";
import { hashPassword } from "./passwords";

/** The admin account to create on first start (ADMIN_EMAIL / ADMIN_NAME / ADMIN_PASSWORD). */
export interface InitialAdmin {
  email: string;
  name: string;
  password: string;
}

/** Setup codes look like "Q82FC-3CKAP": unambiguous characters (no 0/O, 1/I/L). */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
/** A setup code's fingerprint (spaces, dashes and case don't matter). */
const digest = (code: string) => createHash("sha256").update(code.toUpperCase().replace(/[\s-]/g, "")).digest("hex");
const sameDigest = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const newCode = () => Array.from({ length: 11 }, (_, i) => (i === 5 ? "-" : ALPHABET[randomInt(ALPHABET.length)])).join("");

/**
 * Who may create the first admin. With ADMIN_* configured, the server creates it on start. Without,
 * the web setup page also asks for a one-time setup code printed in the server's log — so a fresh
 * install on the internet can't be claimed by whoever happens to open it first. With single sign-on,
 * the first admin can also be whoever signs in as ADMIN_EMAIL (or, without it, from one of
 * OIDC_ALLOWED_DOMAINS); see the single sign-on routes.
 */
export class FirstRun {
  /** this copy's code (fixed, or made the first time it's needed) */
  private code: string | null;
  /** fixed codes (tests) aren't printed */
  private announced: boolean;

  constructor(
    private readonly db: Db,
    private readonly instance: InstanceService,
    private readonly announce: (message: string) => void,
    /** a fixed code (tests); otherwise a random one is made when needed */
    fixedCode?: string,
    /** several copies: the code's hash is shared through the database, and one copy prints it */
    private readonly shared = false,
  ) {
    this.code = fixedCode ?? null;
    this.announced = fixedCode !== undefined;
  }

  /** On start: create the configured admin when nobody has an account yet; otherwise say how to set up. */
  async start(admin: InitialAdmin | null): Promise<void> {
    if ((await this.db.user.count()) > 0) return;
    if (admin) {
      await this.createAdmin(admin);
      this.announce(`Created the admin account ${admin.email} (from ADMIN_EMAIL). You can now remove ADMIN_PASSWORD from the settings.`);
      return;
    }
    await this.needsSetup();
  }

  /**
   * No accounts yet; makes (and prints) the setup code the first time it's needed. With several
   * copies, the first to store its code's hash prints it; the others point to its log (and a copy
   * stores its own again if the database lost it).
   */
  async needsSetup(): Promise<boolean> {
    if ((await this.db.user.count()) > 0) return false;
    if (this.code === null) this.code = newCode();
    let printsCode = true;
    if (this.shared) {
      // Atomic: copies starting together may both get here first.
      await this.db.$executeRaw`INSERT INTO "Settings" (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
      const { count } = await this.db.settings.updateMany({ where: { id: 1, setupCodeHash: null }, data: { setupCodeHash: digest(this.code) } });
      printsCode = count === 1;
    }
    if (!this.announced) {
      this.announce(
        printsCode
          ? `No admin account yet. To create it in the browser, use this setup code: ${this.code}`
          : "No admin account yet. The setup code is in another GanttLines copy's log.",
      );
      this.announced = true;
    }
    return true;
  }

  /** Whether `input` is the current setup code (spaces, dashes and case don't matter). */
  async checkCode(input: string): Promise<boolean> {
    if (!this.shared) {
      if (this.code === null) return false;
      return sameDigest(digest(input), digest(this.code));
    }
    if (!(await this.needsSetup())) return false;
    const stored = (await this.db.settings.findUnique({ where: { id: 1 }, select: { setupCodeHash: true } }))?.setupCodeHash;
    return stored != null && sameDigest(digest(input), stored);
  }

  /** Creates the first admin (and their team member) — only while there are no accounts at all. */
  async createAdmin({ email, name, password }: InitialAdmin): Promise<User> {
    return this.create({ email, name, passwordHash: await hashPassword(password) });
  }

  /**
   * The first admin, signing in with single sign-on: their account is tied to the provider and has
   * a password nobody knows (they can set one with "Forgot your password?").
   */
  async createAdminFromSso({ email, name, subject }: { email: string; name: string; subject: string }): Promise<User> {
    return this.create({ email, name, passwordHash: await hashPassword(randomBytes(32).toString("base64url")), oidcSubject: subject });
  }

  private create(data: { email: string; name: string; passwordHash: string; oidcSubject?: string }): Promise<User> {
    // The admin and their team member are created together (one instance mutation).
    return this.instance.mutate(actorOf, "setup", { email: data.email }, async (tx) => {
      // Serialise concurrent setup attempts; only the first may create the admin.
      await tx.$executeRaw`LOCK TABLE "User" IN EXCLUSIVE MODE`;
      if ((await tx.user.count()) > 0) throw conflict("Setup has already been completed");
      await tx.settings.updateMany({ where: { id: 1 }, data: { setupCodeHash: null } });
      const created = await tx.user.create({ data: { ...data, role: "admin" } });
      await insertResource(tx, { name: created.name, userId: created.id });
      return created;
    });
  }
}
