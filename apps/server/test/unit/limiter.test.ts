import { describe, expect, it } from "vitest";
import { MAX_TRACKED_KEYS, MemoryLimiter } from "../../src/auth/limiter";

describe("MemoryLimiter", () => {
  it("blocks a key after 10 failures within 15 minutes and forgets them afterwards", async () => {
    let now = 0;
    const limiter = new MemoryLimiter(() => now);
    for (let i = 0; i < 10; i++) await limiter.recordFailure(["ip:1"]);
    expect(await limiter.isBlocked(["ip:1"])).toBe(true);
    now += 15 * 60 * 1000 + 1;
    expect(await limiter.isBlocked(["ip:1"])).toBe(false);
  });

  it("never tracks more than MAX_TRACKED_KEYS keys", async () => {
    const limiter = new MemoryLimiter(() => 0);
    for (let i = 0; i < MAX_TRACKED_KEYS + 50; i++) await limiter.recordFailure([`email:${i}@example.com`]);
    expect(limiter.trackedKeys).toBe(MAX_TRACKED_KEYS);
  });

  it("never drops a key's failures to make room, once they're halfway to the limit", async () => {
    const limiter = new MemoryLimiter(() => 0, { windowMs: 60_000, max: 10 }, { maxKeys: 5 });
    for (let i = 0; i < 6; i++) await limiter.recordFailure(["email:target"]);
    for (let k = 0; k < 20; k++) await limiter.recordFailure([`email:flood-${k}`]);
    for (let i = 0; i < 4; i++) await limiter.recordFailure(["email:target"]);
    expect(await limiter.isBlocked(["email:target"])).toBe(true);
  });
});
