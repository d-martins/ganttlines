import type { Db, ShareLink } from "@ganttlines/db";
import { describe, expect, it } from "vitest";
import { AccessService } from "../../src/auth/access";

const LINK: ShareLink = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  tokenHash: "",
  access: "anonymous",
  collaboration: true,
  label: "",
  createdByUserId: null,
  createdByLabel: "Admin",
  createdAt: new Date(0),
  revokedAt: null,
};

/** A fake database whose link lookups can be held open, to interleave them with a revoke. */
function gatedDb() {
  let row: ShareLink | null = LINK;
  const gates: (() => void)[] = [];
  const db = {
    shareLink: {
      findUnique: () => {
        const snapshot = row;
        return new Promise<ShareLink | null>((resolve) => gates.push(() => resolve(snapshot)));
      },
    },
  } as unknown as Db;
  return { db, revoke: () => (row = { ...LINK, revokedAt: new Date() }), release: () => gates.splice(0).forEach((open) => open()) };
}

describe("AccessService link cache", () => {
  it("never keeps a lookup that was in flight while the link was revoked", async () => {
    const { db, revoke, release } = gatedDb();
    const access = new AccessService(db, "x".repeat(32));
    const inFlight = access.link("token");
    revoke();
    access.invalidate(LINK.id);
    release();
    expect(await inFlight).not.toBeNull(); // this lookup started before the revoke…
    const after = access.link("token");
    release();
    expect(await after).toBeNull(); // …but the next one sees it
  });

  it("does not cache unknown tokens", async () => {
    let lookups = 0;
    const db = { shareLink: { findUnique: async () => (lookups++, null) } } as unknown as Db;
    const access = new AccessService(db, "x".repeat(32));
    await access.link("nope");
    await access.link("nope");
    expect(lookups).toBe(2);
  });

  it("verifies visitor cookies", () => {
    const access = new AccessService({} as Db, "x".repeat(32));
    const cookie = access.signVisitor({ id: "v1", name: "Rudy" });
    expect(access.readVisitor(cookie)).toEqual({ id: "v1", name: "Rudy" });
    expect(access.readVisitor(`${cookie}x`)).toBeNull();
    expect(new AccessService({} as Db, "y".repeat(32)).readVisitor(cookie)).toBeNull();
  });
});
