import type { Viewer } from "@ganttlines/protocol";
import type { ClusterEvent, EventBus } from "../cluster/types";
import type { Hub } from "./hub";

/** Room for a room's viewers in one notification to other copies (they're under 8000 bytes in all). */
const ANNOUNCED_BYTES = 7000;

/**
 * Who is viewing each board, across copies: this copy's viewers (from the hub) plus what other
 * copies announce — on join/leave and every `heartbeatMs`. A copy silent for `ttlMs`, or saying
 * goodbye, is dropped.
 */
export class Presence {
  private readonly remote = new Map<string, { seen: number; rooms: Map<string, Viewer[]> }>();
  private timer: NodeJS.Timeout | undefined;
  private expiry: NodeJS.Timeout | undefined;
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
    void this.bus.publish({ type: "presence", projectId, viewers: this.announced(projectId) });
  }

  receive(event: Extract<ClusterEvent, { type: "presence" | "rooms" | "alive" | "bye" }>, from: string): void {
    if (event.type === "bye") return this.drop(from);
    const copy = this.remote.get(from) ?? { seen: 0, rooms: new Map<string, Viewer[]>() };
    copy.seen = this.now();
    this.remote.set(from, copy);
    if (event.type === "alive") return;
    if (event.type === "rooms") {
      // Rooms it doesn't list any more emptied while their notice was lost.
      const listed = new Set(event.projectIds);
      for (const projectId of [...copy.rooms.keys()]) {
        if (listed.has(projectId)) continue;
        copy.rooms.delete(projectId);
        this.hub.broadcast(projectId, { type: "presence", projectId, viewers: this.viewers(projectId) });
      }
      return;
    }
    if (event.viewers.length) copy.rooms.set(event.projectId, event.viewers);
    else copy.rooms.delete(event.projectId);
    this.hub.broadcast(event.projectId, { type: "presence", projectId: event.projectId, viewers: this.viewers(event.projectId) });
  }

  /** Forgets other copies' viewers (after missing notices); their next heartbeat brings them back. */
  reset(): void {
    const rooms = new Set([...this.remote.values()].flatMap((copy) => [...copy.rooms.keys()]));
    this.remote.clear();
    for (const projectId of rooms) this.hub.broadcast(projectId, { type: "presence", projectId, viewers: this.viewers(projectId) });
  }

  /** Drops copies that went quiet (crashed without saying goodbye). */
  expire(): void {
    for (const [copyId, copy] of this.remote) if (this.now() - copy.seen > this.ttlMs) this.drop(copyId);
  }

  /**
   * Heartbeat: re-announce this copy's rooms (and that it's alive). Quiet copies are checked more
   * often than that, so their viewers go close to `ttlMs` after their last word.
   */
  start(): void {
    this.timer = setInterval(() => {
      void this.bus.publish({ type: "alive" });
      void this.bus.publish({ type: "rooms", projectIds: this.hub.rooms() });
      for (const projectId of this.hub.rooms()) {
        void this.bus.publish({ type: "presence", projectId, viewers: this.announced(projectId) });
      }
    }, this.heartbeatMs);
    this.timer.unref();
    this.expiry = setInterval(() => this.expire(), Math.min(5000, Math.max(50, this.ttlMs / 10)));
    this.expiry.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    clearInterval(this.expiry);
    await this.bus.publish({ type: "bye" });
  }

  /** This copy's viewers of `projectId`, as many as fit in a notification (a crowded room is trimmed). */
  private announced(projectId: string): Viewer[] {
    const fitting: Viewer[] = [];
    let bytes = 0;
    for (const viewer of this.hub.viewers(projectId)) {
      bytes += Buffer.byteLength(JSON.stringify(viewer)) + 1;
      if (bytes > ANNOUNCED_BYTES) break;
      fitting.push(viewer);
    }
    return fitting;
  }

  private drop(copyId: string): void {
    const copy = this.remote.get(copyId);
    if (!copy) return;
    this.remote.delete(copyId);
    for (const projectId of copy.rooms.keys()) this.hub.broadcast(projectId, { type: "presence", projectId, viewers: this.viewers(projectId) });
  }
}
