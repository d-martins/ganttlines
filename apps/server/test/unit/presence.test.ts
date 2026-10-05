import { describe, expect, it } from "vitest";
import type { ClusterEvent, EventBus } from "../../src/cluster/types";
import { Hub } from "../../src/realtime/hub";
import { Presence } from "../../src/realtime/presence";

const bus = (): EventBus & { sent: ClusterEvent[] } => {
  const sent: ClusterEvent[] = [];
  return { copyId: "me", ready: true, sent, publish: async (event) => void sent.push(event), subscribe: () => undefined, onResync: () => undefined, close: async () => undefined };
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
});
