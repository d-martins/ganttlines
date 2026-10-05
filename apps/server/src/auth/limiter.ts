import type { Db } from "@ganttlines/db";
import { createHash } from "node:crypto";

/** Counts failures (or calls) per key; blocks a key once it reaches the limit within the window. */
export interface Limiter {
  isBlocked(keys: string[]): Promise<boolean>;
  recordFailure(keys: string[]): Promise<void>;
  reset(keys: string[]): Promise<void>;
  /** Forgets counts that can no longer block anyone. */
  deleteOld(): Promise<void>;
}

export interface LimitOptions {
  windowMs: number;
  max: number;
}

const DEFAULT: LimitOptions = { windowMs: 15 * 60 * 1000, max: 10 };
/** Upper bound on tracked keys so a flood of distinct IPs/emails cannot exhaust memory. */
export const MAX_TRACKED_KEYS = 10_000;

/** One copy: failures per key in a sliding window, in memory. */
export class MemoryLimiter implements Limiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly options: LimitOptions = DEFAULT,
  ) {}

  async isBlocked(keys: string[]): Promise<boolean> {
    return keys.some((key) => this.recent(key).length >= this.options.max);
  }

  async recordFailure(keys: string[]): Promise<void> {
    for (const key of keys) {
      const failures = [...this.recent(key), this.now()];
      this.failures.delete(key); // re-insert so Map order stays "least recently failed first"
      this.failures.set(key, failures);
    }
    if (this.failures.size > MAX_TRACKED_KEYS) this.prune();
  }

  async reset(keys: string[]): Promise<void> {
    for (const key of keys) this.failures.delete(key);
  }

  async deleteOld(): Promise<void> {
    this.prune();
  }

  get trackedKeys(): number {
    return this.failures.size;
  }

  /** Drops expired entries, then the least recently failed keys beyond the cap. */
  private prune(): void {
    for (const key of [...this.failures.keys()]) {
      if (this.recent(key).length === 0) this.failures.delete(key);
    }
    for (const key of this.failures.keys()) {
      if (this.failures.size <= MAX_TRACKED_KEYS) break;
      this.failures.delete(key);
    }
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.options.windowMs;
    return (this.failures.get(key) ?? []).filter((time) => time > cutoff);
  }
}

/** Several copies: counts per hashed key in fixed windows, in a table (emails and IPs aren't stored). */
export class PgLimiter implements Limiter {
  constructor(
    private readonly db: Db,
    /** keeps different limits' keys apart */
    private readonly name: string,
    private readonly options: LimitOptions = DEFAULT,
    private readonly now: () => number = Date.now,
  ) {}

  async isBlocked(keys: string[]): Promise<boolean> {
    const rows = await this.db.rateCounter.findMany({ where: { key: { in: keys.map((key) => this.hash(key)) }, windowStart: this.window() } });
    return rows.some((row) => row.count >= this.options.max);
  }

  async recordFailure(keys: string[]): Promise<void> {
    const windowStart = this.window();
    for (const key of keys) {
      const hashed = this.hash(key);
      await this.db.rateCounter.upsert({
        where: { key_windowStart: { key: hashed, windowStart } },
        create: { key: hashed, windowStart, count: 1 },
        update: { count: { increment: 1 } },
      });
    }
  }

  async reset(keys: string[]): Promise<void> {
    await this.db.rateCounter.deleteMany({ where: { key: { in: keys.map((key) => this.hash(key)) } } });
  }

  async deleteOld(): Promise<void> {
    await this.db.rateCounter.deleteMany({ where: { key: { startsWith: `${this.name}:` }, windowStart: { lt: this.window() } } });
  }

  private window(): bigint {
    return BigInt(Math.floor(this.now() / this.options.windowMs) * this.options.windowMs);
  }

  private hash(key: string): string {
    return `${this.name}:${createHash("sha256").update(key).digest("hex")}`;
  }
}
