const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

/** In-memory failed-login counter per key (client IP, and account email). */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  isBlocked(keys: string[]): boolean {
    return keys.some((key) => this.recent(key).length >= MAX_FAILURES);
  }

  recordFailure(keys: string[]): void {
    for (const key of keys) this.failures.set(key, [...this.recent(key), this.now()]);
  }

  reset(keys: string[]): void {
    for (const key of keys) this.failures.delete(key);
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - WINDOW_MS;
    return (this.failures.get(key) ?? []).filter((time) => time > cutoff);
  }
}
