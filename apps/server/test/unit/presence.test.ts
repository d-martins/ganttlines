import { describe, expect, it } from "vitest";
import type { ClusterEvent, EventBus } from "../../src/cluster/types";
import { Hub } from "../../src/realtime/hub";
import { Presence } from "../../src/realtime/presence";

const bus = (): EventBus & { sent: ClusterEvent[] } => {
  const sent: ClusterEvent[] = [];
  return { copyId: "me", ready: true, sent, publish: async (event) => void sent.push(event), notification: () => null, subscribe: () => undefined, onResync: () => undefined, close: async () => undefined };
};

describe("presence across copies", () => {
  it("merges other copies' viewers (each person once) and drops a copy that goes quiet", () => {
    let now = 0;
    const presence = new Presence(new Hub(), bus(), { now: () => now, ttlMs: 90_000 });
    presence.receive({ type: "presence", projectId: "p", viewers: [{ id: "user:1", name: "Ana" }] }, "copy-b");
    presence.receive({ type: "presence", projectId: "p", viewers: [{ id: "user:1", name: "Ana" }, { id: "user:2", name: "Bo" }] }, "copy-c");
    expect(presence.viewers("p").map((v) => v.name)).toEqual(["Ana", "Bo"]);
    now = 60_000;
    presence.receive({ type: "alive" }, "copy-b");
    now = 100_000;
    presence.expire();
    expect(presence.viewers("p").map((v) => v.name)).toEqual(["Ana"]); // copy-c went quiet
    presence.receive({ type: "bye" }, "copy-b");
    expect(presence.viewers("p")).toEqual([]);
  });

  it("drops rooms a copy no longer lists (a lost 'room is empty' notice), and starts afresh after a resync", () => {
    const presence = new Presence(new Hub(), bus());
    presence.receive({ type: "presence", projectId: "p", viewers: [{ id: "user:1", name: "Ana" }] }, "copy-b");
    presence.receive({ type: "presence", projectId: "q", viewers: [{ id: "user:2", name: "Bo" }] }, "copy-b");
    presence.receive({ type: "rooms", projectIds: ["p"] }, "copy-b"); // copy-b's heartbeat: only p has viewers now
    expect(presence.viewers("q")).toEqual([]);
    expect(presence.viewers("p").map((v) => v.name)).toEqual(["Ana"]);
    presence.reset();
    expect(presence.viewers("p")).toEqual([]);
  });

  it("announces a crowded room's viewers trimmed to fit one notification, rather than not at all", () => {
    const hub = new Hub();
    const crowd = Array.from({ length: 150 }, (_, i) => ({ id: `user:${i.toString().padStart(36, "0")}`, name: `Someone With A Rather Long Display Name ${i}` }));
    hub.viewers = () => crowd;
    const sent = bus();
    new Presence(hub, sent).changed("11111111-1111-4111-8111-111111111111");
    const event = sent.sent[0] as Extract<ClusterEvent, { type: "presence" }>;
    expect(event.viewers.length).toBeGreaterThan(50);
    expect(Buffer.byteLength(JSON.stringify({ from: "f".repeat(36), event }))).toBeLessThanOrEqual(7900);
  });

  it("drops a quiet copy's viewers soon after it went quiet, not at the next heartbeat", async () => {
    const presence = new Presence(new Hub(), bus(), { heartbeatMs: 60_000, ttlMs: 300 });
    presence.start();
    try {
      presence.receive({ type: "presence", projectId: "p", viewers: [{ id: "user:1", name: "Ana" }] }, "copy-b");
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(presence.viewers("p")).toEqual([]);
    } finally {
      await presence.stop();
    }
  });
});
