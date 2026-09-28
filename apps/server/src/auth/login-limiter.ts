const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
/** Upper bound on tracked keys so a flood of distinct IPs/emails cannot exhaust memory. */
export const MAX_TRACKED_KEYS = 10_000;

/** In-memory failed-login counter per key (client IP, and account email). */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  isBlocked(keys: string[]): boolean {
    return keys.some((key) => this.recent(key).length >= MAX_FAILURES);
  }

  recordFailure(keys: string[]): void {
    for (const key of keys) {
      const failures = [...this.recent(key), this.now()];
      this.failures.delete(key); // re-insert so Map order stays "least recently failed first"
      this.failures.set(key, failures);
    }
    if (this.failures.size > MAX_TRACKED_KEYS) this.prune();
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

  reset(keys: string[]): void {
    for (const key of keys) this.failures.delete(key);
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - WINDOW_MS;
    return (this.failures.get(key) ?? []).filter((time) => time > cutoff);
  }
}
