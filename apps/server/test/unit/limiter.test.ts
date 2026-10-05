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

  it("never drops an account's failures to make room, however full the table is", async () => {
    const limiter = new MemoryLimiter(() => 0, { windowMs: 60_000, max: 10 }, { maxKeys: 5 });
    for (let k = 0; k < 20; k++) for (let i = 0; i < 9; i++) await limiter.recordFailure([`ip:flood-${k}`]); // a full table of busy keys
    for (let i = 0; i < 10; i++) await limiter.recordFailure([`ip:new-${i}`, "user:target"]);
    expect(await limiter.isBlocked(["user:target"])).toBe(true);
  });

  it("stays bounded: other keys make room, busiest or not", async () => {
    const limiter = new MemoryLimiter(() => 0, { windowMs: 60_000, max: 10 }, { maxKeys: 5 });
    for (let k = 0; k < 30; k++) for (let i = 0; i < 9; i++) await limiter.recordFailure([`ip:${k}`]);
    expect(limiter.trackedKeys).toBeLessThanOrEqual(5);
  });

  it("counts attempts as they start, so parallel ones can't get past the limit", async () => {
    const limiter = new MemoryLimiter(() => 0);
    const allowed = await Promise.all(Array.from({ length: 30 }, () => limiter.attempt(["user:target"])));
    expect(allowed.filter(Boolean)).toHaveLength(10);
  });
});
