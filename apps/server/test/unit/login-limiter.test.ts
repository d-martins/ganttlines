import { describe, expect, it } from "vitest";
import { LoginLimiter, MAX_TRACKED_KEYS } from "../../src/auth/login-limiter";

describe("LoginLimiter", () => {
  it("blocks a key after 10 failures within 15 minutes and forgets them afterwards", () => {
    let now = 0;
    const limiter = new LoginLimiter(() => now);
    for (let i = 0; i < 10; i++) limiter.recordFailure(["ip:1"]);
    expect(limiter.isBlocked(["ip:1"])).toBe(true);
    now += 15 * 60 * 1000 + 1;
    expect(limiter.isBlocked(["ip:1"])).toBe(false);
  });

  it("never tracks more than MAX_TRACKED_KEYS keys", () => {
    const limiter = new LoginLimiter(() => 0);
    for (let i = 0; i < MAX_TRACKED_KEYS + 50; i++) limiter.recordFailure([`email:${i}@example.com`]);
    expect(limiter.trackedKeys).toBe(MAX_TRACKED_KEYS);
  });
});
