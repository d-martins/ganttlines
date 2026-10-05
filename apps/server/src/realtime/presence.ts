import type { Viewer } from "@ganttlines/protocol";
import type { ClusterEvent, EventBus } from "../cluster/types";
import type { Hub } from "./hub";

/** At most this many viewers per project are announced to other copies (notifications are small). */
const MAX_ANNOUNCED = 100;

/**
 * Who is viewing each board, across copies: this copy's viewers (from the hub) plus what other
 * copies announce — on join/leave and every `heartbeatMs`. A copy silent for `ttlMs`, or saying
 * goodbye, is dropped.
 */
export class Presence {
  private readonly remote = new Map<string, { seen: number; rooms: Map<string, Viewer[]> }>();
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => number;
  private readonly heartbeatMs: number;
  private readonly ttlMs: number;

  constructor(
    private readonly hub: Hub,
    private readonly bus: EventBus,
    options: { now?: () => number; heartbeatMs?: number; ttlMs?: number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    this.ttlMs = options.ttlMs ?? 90_000;
  }

  /** Everyone viewing `projectId`, each person once (this copy's first). */
  viewers(projectId: string): Viewer[] {
    const all = new Map<string, Viewer>();
    for (const viewer of this.hub.viewers(projectId)) all.set(viewer.id, viewer);
    for (const { rooms } of this.remote.values()) {
      for (const viewer of rooms.get(projectId) ?? []) if (!all.has(viewer.id)) all.set(viewer.id, viewer);
    }
    return [...all.values()];
  }

  /** This copy's viewers of `projectId` changed: tell its browsers and the other copies. */
  changed(projectId: string): void {
    this.hub.broadcast(projectId, { type: "presence", projectId, viewers: this.viewers(projectId) });
    void this.bus.publish({ type: "presence", projectId, viewers: this.hub.viewers(projectId).slice(0, MAX_ANNOUNCED) });
  }

  receive(event: Extract<ClusterEvent, { type: "presence" | "alive" | "bye" }>, from: string): void {
    if (event.type === "bye") return this.drop(from);
    const copy = this.remote.get(from) ?? { seen: 0, rooms: new Map<string, Viewer[]>() };
    copy.seen = this.now();
    this.remote.set(from, copy);
    if (event.type === "alive") return;
    if (event.viewers.length) copy.rooms.set(event.projectId, event.viewers);
    else copy.rooms.delete(event.projectId);
    this.hub.broadcast(event.projectId, { type: "presence", projectId: event.projectId, viewers: this.viewers(event.projectId) });
  }

  /** Drops copies that went quiet (crashed without saying goodbye). */
  expire(): void {
    for (const [copyId, copy] of this.remote) if (this.now() - copy.seen > this.ttlMs) this.drop(copyId);
  }

  /** Heartbeat: re-announce this copy's rooms (and that it's alive); expire quiet copies. */
  start(): void {
    this.timer = setInterval(() => {
      void this.bus.publish({ type: "alive" });
      for (const projectId of this.hub.rooms()) {
        void this.bus.publish({ type: "presence", projectId, viewers: this.hub.viewers(projectId).slice(0, MAX_ANNOUNCED) });
      }
      this.expire();
    }, this.heartbeatMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.bus.publish({ type: "bye" });
  }

  private drop(copyId: string): void {
    const copy = this.remote.get(copyId);
    if (!copy) return;
    this.remote.delete(copyId);
    for (const projectId of copy.rooms.keys()) this.hub.broadcast(projectId, { type: "presence", projectId, viewers: this.viewers(projectId) });
  }
}
