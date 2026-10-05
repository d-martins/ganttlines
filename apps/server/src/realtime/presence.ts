import type { Viewer } from "@ganttlines/protocol";
import type { ClusterEvent, EventBus } from "../cluster/types";
import type { Hub } from "./hub";

/** Who is viewing each board (this copy's viewers; other copies' come next). */
export class Presence {
  constructor(
    private readonly hub: Hub,
    private readonly bus: EventBus,
  ) {}

  viewers(projectId: string): Viewer[] {
    return this.hub.viewers(projectId);
  }

  changed(projectId: string): void {
    this.hub.broadcast(projectId, { type: "presence", projectId, viewers: this.viewers(projectId) });
    void this.bus;
  }

  receive(_event: Extract<ClusterEvent, { type: "presence" | "alive" | "bye" }>, _from: string): void {}
}
