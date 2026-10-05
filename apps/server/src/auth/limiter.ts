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
  private readonly maxKeys: number;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly options: LimitOptions = DEFAULT,
    { maxKeys = MAX_TRACKED_KEYS }: { maxKeys?: number } = {},
  ) {
    this.maxKeys = maxKeys;
  }

  async isBlocked(keys: string[]): Promise<boolean> {
    return keys.some((key) => this.recent(key).length >= this.options.max);
  }

  async recordFailure(keys: string[]): Promise<void> {
    for (const key of keys) {
      const failures = [...this.recent(key), this.now()];
      this.failures.delete(key); // re-insert so Map order stays "least recently failed first"
      this.failures.set(key, failures);
    }
    if (this.failures.size > this.maxKeys) this.prune();
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

  /**
   * Drops expired entries, then the least recently failed keys beyond the cap — but never a key
   * halfway to the limit or more, so flooding other keys can't wipe an account's count.
   */
  private prune(): void {
    for (const key of [...this.failures.keys()]) {
      if (this.recent(key).length === 0) this.failures.delete(key);
    }
    for (const key of [...this.failures.keys()]) {
      if (this.failures.size <= this.maxKeys) break;
      if (this.recent(key).length < this.options.max / 2) this.failures.delete(key);
    }
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.options.windowMs;
    return (this.failures.get(key) ?? []).filter((time) => time > cutoff);
  }
}

/**
 * Several copies: counts per hashed key in fixed windows, in a table (emails and IPs aren't stored).
 * A key is blocked while its current and previous windows together reach the limit — so attempts
 * can't straddle a window boundary to get twice as many (a lockout lasts one to two windows). The
 * table stays bounded: old windows are pruned regularly, and beyond `maxKeys` the keys with the
 * fewest attempts are dropped first (never ones halfway to the limit: flooding costs at least that
 * many attempts per key, and can't wipe an account's count).
 */
export class PgLimiter implements Limiter {
  private sincePrune = 0;
  private readonly maxKeys: number;
  private readonly pruneEvery: number;

  constructor(
    private readonly db: Db,
    /** keeps different limits' keys apart */
    private readonly name: string,
    private readonly options: LimitOptions = DEFAULT,
    private readonly now: () => number = Date.now,
    { maxKeys = MAX_TRACKED_KEYS, pruneEvery = 100 }: { maxKeys?: number; pruneEvery?: number } = {},
  ) {
    this.maxKeys = maxKeys;
    this.pruneEvery = pruneEvery;
  }

  async isBlocked(keys: string[]): Promise<boolean> {
    const current = this.window();
    const rows = await this.db.rateCounter.findMany({
      where: { key: { in: keys.map((key) => this.hash(key)) }, windowStart: { in: [current, current - BigInt(this.options.windowMs)] } },
    });
    const totals = new Map<string, number>();
    for (const row of rows) totals.set(row.key, (totals.get(row.key) ?? 0) + row.count);
    return [...totals.values()].some((total) => total >= this.options.max);
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
    if (++this.sincePrune >= this.pruneEvery) {
      this.sincePrune = 0;
      await this.prune();
    }
  }

  async reset(keys: string[]): Promise<void> {
    await this.db.rateCounter.deleteMany({ where: { key: { in: keys.map((key) => this.hash(key)) } } });
  }

  async deleteOld(): Promise<void> {
    await this.prune();
  }

  /** Drops windows that can't count any more, then the least-tried keys beyond `maxKeys`. */
  private async prune(): Promise<void> {
    const prefix = `${this.name}:`;
    await this.db.rateCounter.deleteMany({ where: { key: { startsWith: prefix }, windowStart: { lt: this.window() - BigInt(this.options.windowMs) } } });
    const excess = (await this.db.rateCounter.count({ where: { key: { startsWith: prefix } } })) - this.maxKeys;
    if (excess <= 0) return;
    // Never a count halfway to the limit or more: flooding other keys can't wipe an account's count.
    await this.db.$executeRaw`
      DELETE FROM "RateCounter" WHERE ("key", "windowStart") IN (
        SELECT "key", "windowStart" FROM "RateCounter"
        WHERE "key" LIKE ${`${prefix}%`} AND "count" < ${this.options.max / 2}
        ORDER BY "count" ASC, "windowStart" ASC LIMIT ${excess}
      )`;
  }

  private window(): bigint {
    return BigInt(Math.floor(this.now() / this.options.windowMs) * this.options.windowMs);
  }

  private hash(key: string): string {
    return `${this.name}:${createHash("sha256").update(key).digest("hex")}`;
  }
}
