/** Where new versions are published. */
export const RELEASES_URL = "https://api.github.com/repos/d-martins/ganttlines/releases/latest";

const DAY = 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE = 60 * 60 * 1000;
const TIMEOUT = 5000;

export interface Release {
  version: string;
  url: string;
}

/** "v1.10.0" → [1, 10, 0]; null when it isn't a plain x.y.z version (e.g. "dev"). */
function parts(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Whether `candidate` is a newer x.y.z than `current` (never for versions that can't be compared). */
export function isNewer(candidate: string, current: string): boolean {
  const [a, b] = [parts(candidate), parts(current)];
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  return false;
}

/**
 * Asks GitHub for the latest release — at most once a day (once an hour after a failure), with a
 * short timeout; offline or blocked servers just get null. Only called while the check is on.
 */
export class UpdateChecker {
  private cached: { release: Release | null; until: number } | null = null;
  private pending: Promise<Release | null> | null = null;

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly url = RELEASES_URL,
  ) {}

  latest(): Promise<Release | null> {
    if (this.cached && this.now() < this.cached.until) return Promise.resolve(this.cached.release);
    this.pending ??= this.fetchLatest().finally(() => (this.pending = null));
    return this.pending;
  }

  private async fetchLatest(): Promise<Release | null> {
    try {
      const response = await this.fetchFn(this.url, {
        headers: { accept: "application/vnd.github+json", "user-agent": "ganttlines-update-check" },
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      const body = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
      const version = typeof body.tag_name === "string" ? body.tag_name.replace(/^v/, "") : null;
      const release = version && typeof body.html_url === "string" ? { version, url: body.html_url } : null;
      this.cached = { release, until: this.now() + DAY };
      return release;
    } catch {
      this.cached = { release: this.cached?.release ?? null, until: this.now() + RETRY_AFTER_FAILURE };
      return this.cached.release;
    }
  }
}
