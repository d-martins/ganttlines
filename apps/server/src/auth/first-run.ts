import { randomInt, timingSafeEqual } from "node:crypto";
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
const newCode = () => Array.from({ length: 11 }, (_, i) => (i === 5 ? "-" : ALPHABET[randomInt(ALPHABET.length)])).join("");

/**
 * Who may create the first admin. With ADMIN_* configured, the server creates it on start. Without,
 * the web setup page also asks for a one-time setup code printed in the server's log — so a fresh
 * install on the internet can't be claimed by whoever happens to open it first.
 */
export class FirstRun {
  private code: string | null;

  constructor(
    private readonly db: Db,
    private readonly instance: InstanceService,
    private readonly announce: (message: string) => void,
    /** a fixed code (tests); otherwise a random one is made when needed */
    fixedCode?: string,
  ) {
    this.code = fixedCode ?? null;
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

  /** No accounts yet; makes (and prints) the setup code the first time it's needed. */
  async needsSetup(): Promise<boolean> {
    if ((await this.db.user.count()) > 0) return false;
    if (this.code === null) {
      this.code = newCode();
      this.announce(`No admin account yet. To create it in the browser, use this setup code: ${this.code}`);
    }
    return true;
  }

  /** Whether `input` is the current setup code (spaces, dashes and case don't matter). */
  checkCode(input: string): boolean {
    if (this.code === null) return false;
    const normalise = (value: string) => Buffer.from(value.toUpperCase().replace(/[\s-]/g, ""));
    const [given, expected] = [normalise(input), normalise(this.code)];
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /** Creates the first admin (and their team member) — only while there are no accounts at all. */
  async createAdmin({ email, name, password }: InitialAdmin): Promise<User> {
    const passwordHash = await hashPassword(password);
    // The admin and their team member are created together (one instance mutation).
    return this.instance.mutate(actorOf, "setup", { email }, async (tx) => {
      // Serialise concurrent setup attempts; only the first may create the admin.
      await tx.$executeRaw`LOCK TABLE "User" IN EXCLUSIVE MODE`;
      if ((await tx.user.count()) > 0) throw conflict("Setup has already been completed");
      const created = await tx.user.create({ data: { email, name, passwordHash, role: "admin" } });
      await insertResource(tx, { name: created.name, userId: created.id });
      return created;
    });
  }
}
