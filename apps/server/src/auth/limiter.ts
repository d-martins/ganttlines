import type { Db } from "@ganttlines/db";
import { createHmac } from "node:crypto";

/**
 * Counts failures (or calls) per key; blocks a key once it reaches the limit within the window.
 * Account keys (`user:…`, `2fa:…`) are never dropped to make room — there are only as many as
 * accounts — so flooding other keys can't wipe an account's count; any other key (IPs, typed-in
 * emails: unbounded) can be, least recently tried first.
 */
export interface Limiter {
  /**
   * Counts an attempt before it's made and says whether it may go ahead (so parallel attempts can't
   * all pass a check before any is counted). On success, `reset` the keys if success shouldn't count.
   */
  attempt(keys: string[]): Promise<boolean>;
  isBlocked(keys: string[]): Promise<boolean>;
  recordFailure(keys: string[]): Promise<void>;
  /** Takes back one counted attempt (one that succeeded and shouldn't count against these keys). */
  refund(keys: string[]): Promise<void>;
  reset(keys: string[]): Promise<void>;
  /** Forgets counts that can no longer block anyone. */
  deleteOld(): Promise<void>;
}

export interface LimitOptions {
  windowMs: number;
  max: number;
  /**
   * With several copies: count the previous window only as far as it still overlaps the last
   * `windowMs` (a budget for calls, not halved at each window start) instead of in full (strict:
   * nothing can straddle a boundary — for guesses).
   */
  sliding?: boolean;
}

const DEFAULT: LimitOptions = { windowMs: 15 * 60 * 1000, max: 10 };
/** Upper bound on tracked non-account keys so a flood of distinct IPs/emails cannot exhaust memory. */
export const MAX_TRACKED_KEYS = 10_000;

/** Keys tied to an account: kept until they expire. */
const isAccountKey = (key: string) => key.startsWith("user:") || key.startsWith("2fa:");

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

  // No awaits before counting: in one process, that makes check-and-count atomic.
  async attempt(keys: string[]): Promise<boolean> {
    const allowed = !keys.some((key) => this.recent(key).length >= this.options.max);
    if (allowed) this.count(keys);
    return allowed;
  }

  async isBlocked(keys: string[]): Promise<boolean> {
    return keys.some((key) => this.recent(key).length >= this.options.max);
  }

  async recordFailure(keys: string[]): Promise<void> {
    this.count(keys);
  }

  async refund(keys: string[]): Promise<void> {
    for (const key of keys) this.failures.get(key)?.pop();
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

  private count(keys: string[]): void {
    for (const key of keys) {
      // (no more than the limit's worth is kept: that's all blocking needs)
      const failures = [...this.recent(key), this.now()].slice(-this.options.max);
      this.failures.delete(key); // re-insert so Map order stays "least recently failed first"
      this.failures.set(key, failures);
    }
    if (this.failures.size > this.maxKeys) this.prune();
  }

  /** Drops expired entries, then the least recently failed non-account keys beyond the cap. */
  private prune(): void {
    let others = 0;
    for (const key of [...this.failures.keys()]) {
      if (this.recent(key).length === 0) this.failures.delete(key);
      else if (!isAccountKey(key)) others++;
    }
    for (const key of [...this.failures.keys()]) {
      if (others <= this.maxKeys) break;
      if (isAccountKey(key)) continue;
      this.failures.delete(key);
      others--;
    }
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.options.windowMs;
    return (this.failures.get(key) ?? []).filter((time) => time > cutoff);
  }
}

/**
 * Several copies: counts per key in fixed windows, in a table (keys are stored as HMACs with the
 * server's secret, so emails and IPs can't be read back). A key's count is the current window's plus
 * the previous one's — in full, so attempts can't straddle a boundary to get twice as many (a lockout
 * lasts one to two windows), or with `sliding`, weighted by how much of it still overlaps the last
 * `windowMs`. Counting is one statement per key, so copies and parallel requests can't overtake each
 * other. The table stays bounded: old windows are pruned regularly, and beyond
 * `maxKeys` non-account keys are dropped, least recently tried first.
 */
export class PgLimiter implements Limiter {
  private sincePrune = 0;
  private readonly maxKeys: number;
  private readonly pruneEvery: number;

  constructor(
    private readonly db: Db,
    /** keys are HMACs with it */
    private readonly secret: string,
    /** keeps different limits' keys apart */
    private readonly name: string,
    private readonly options: LimitOptions = DEFAULT,
    private readonly now: () => number = Date.now,
    { maxKeys = MAX_TRACKED_KEYS, pruneEvery = 100 }: { maxKeys?: number; pruneEvery?: number } = {},
  ) {
    this.maxKeys = maxKeys;
    this.pruneEvery = pruneEvery;
  }

  async attempt(keys: string[]): Promise<boolean> {
    const totals = await this.count(keys);
    return totals.every((total) => total <= this.options.max);
  }

  async isBlocked(keys: string[]): Promise<boolean> {
    const current = this.window();
    const previous = current - BigInt(this.options.windowMs);
    const rows = await this.db.rateCounter.findMany({ where: { key: { in: keys.map((key) => this.hash(key)) }, windowStart: { in: [current, previous] } } });
    const totals = new Map<string, number>();
    for (const row of rows) totals.set(row.key, (totals.get(row.key) ?? 0) + (row.windowStart === current ? row.count : row.count * this.overlap()));
    return [...totals.values()].some((total) => total >= this.options.max);
  }

  async recordFailure(keys: string[]): Promise<void> {
    await this.count(keys);
  }

  async refund(keys: string[]): Promise<void> {
    await this.db.rateCounter.updateMany({
      where: { key: { in: keys.map((key) => this.hash(key)) }, windowStart: this.window(), count: { gt: 0 } },
      data: { count: { decrement: 1 } },
    });
  }

  async reset(keys: string[]): Promise<void> {
    await this.db.rateCounter.deleteMany({ where: { key: { in: keys.map((key) => this.hash(key)) } } });
  }

  async deleteOld(): Promise<void> {
    await this.prune();
  }

  /** How much of the previous window still lies within the last `windowMs` (1 at a window's start, 0 at its end). */
  private overlap(): number {
    if (!this.options.sliding) return 1;
    return 1 - (this.now() % this.options.windowMs) / this.options.windowMs;
  }

  /** Adds one to each key's current window; returns each key's count, this attempt included. */
  private async count(keys: string[]): Promise<number[]> {
    const windowStart = this.window();
    const previous = windowStart - BigInt(this.options.windowMs);
    const totals: number[] = [];
    for (const key of keys) {
      const hashed = this.hash(key);
      const [row] = await this.db.$queryRaw<{ current: number; previous: number }[]>`
        INSERT INTO "RateCounter" ("key", "windowStart", "count") VALUES (${hashed}, ${windowStart}, 1)
        ON CONFLICT ("key", "windowStart") DO UPDATE SET "count" = "RateCounter"."count" + 1
        RETURNING "count" AS current, COALESCE((SELECT "count" FROM "RateCounter" WHERE "key" = ${hashed} AND "windowStart" = ${previous}), 0) AS previous`;
      totals.push(Number(row!.current) + Number(row!.previous) * this.overlap());
    }
    if (++this.sincePrune >= this.pruneEvery) {
      this.sincePrune = 0;
      await this.prune();
    }
    return totals;
  }
  /** Drops windows that can't count any more, then the least recently tried non-account keys beyond `maxKeys`. */
  private async prune(): Promise<void> {
    const prefix = `${this.name}:`;
    const others = `${this.name}:-:%`;
    await this.db.rateCounter.deleteMany({ where: { key: { startsWith: prefix }, windowStart: { lt: this.window() - BigInt(this.options.windowMs) } } });
    const excess = (await this.db.rateCounter.count({ where: { key: { startsWith: `${this.name}:-:` } } })) - this.maxKeys;
    if (excess <= 0) return;
    await this.db.$executeRaw`
      DELETE FROM "RateCounter" WHERE ("key", "windowStart") IN (
        SELECT "key", "windowStart" FROM "RateCounter" WHERE "key" LIKE ${others}
        ORDER BY "windowStart" ASC, "count" ASC LIMIT ${excess}
      )`;
  }

  private window(): bigint {
    return BigInt(Math.floor(this.now() / this.options.windowMs) * this.options.windowMs);
  }

  /** `<name>:a:<hmac>` for account keys, `<name>:-:<hmac>` for the rest (so pruning can tell them apart). */
  private hash(key: string): string {
    return `${this.name}:${isAccountKey(key) ? "a" : "-"}:${createHmac("sha256", this.secret).update(key).digest("hex")}`;
  }
}
