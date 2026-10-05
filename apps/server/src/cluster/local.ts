import { randomUUID } from "node:crypto";
import type { ClusterEvent, EventBus, ProjectLock } from "./types";

/** Single mode: there are no other copies to tell. */
export class LocalBus implements EventBus {
  readonly copyId = randomUUID();
  readonly ready = true;
  async publish(_event: ClusterEvent): Promise<void> {}
  subscribe(): void {}
  notification(): null {
    return null;
  }
  onResync(): void {}
  async close(): Promise<void> {}
}

/** Single mode: the in-memory queues already make work take turns. */
export class NoLock implements ProjectLock {
  run<T>(_key: string, work: () => Promise<T>): Promise<T> {
    return work();
  }
}
