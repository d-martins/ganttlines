import type { ProjectDto, Viewer } from "@ganttlines/protocol";

/** What one copy tells the others (small: big data is re-read from the database by the receiver). */
export type ClusterEvent =
  | { type: "patch"; projectId: string; version: number }
  | { type: "project"; project: ProjectDto }
  | { type: "instance"; version: number }
  | { type: "comment"; commentId: string }
  | { type: "highlights"; projectId: string }
  | { type: "baselines"; projectId: string }
  /** `exceptSession`/`session`: SHA-256 of the session token (tokens never leave the copy) */
  | { type: "closeUser"; userId: string; exceptSession: string | null }
  | { type: "closeSession"; session: string }
  | { type: "closeLink"; linkId: string }
  | { type: "linkChanged"; linkId: string }
  | { type: "projectDeleted"; projectId: string }
  | { type: "presence"; projectId: string; viewers: Viewer[] }
  | { type: "alive" }
  | { type: "bye" };

export interface EventBus {
  /** this copy's id (events carry the sender's) */
  readonly copyId: string;
  /** listening (always true in single mode) */
  readonly ready: boolean;
  /** Tells the other copies (never fails the caller: problems are logged). */
  publish(event: ClusterEvent): Promise<void>;
  subscribe(handler: (event: ClusterEvent, from: string) => void): void;
  /**
   * The statement that announces `event` when run inside a transaction: Postgres delivers it only
   * if (and when) that transaction commits, in commit order. Null in single mode.
   */
  notification(event: ClusterEvent): { sql: string; params: unknown[] } | null;
  /** Called after the bus had to reconnect (events may have been missed). */
  onResync(handler: () => void): void;
  close(): Promise<void>;
}

/** Makes work on one key take turns across copies. */
export interface ProjectLock {
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
}

/** The shared-state pieces for one mode. */
export interface Cluster {
  mode: "single" | "postgres";
  bus: EventBus;
  lock: ProjectLock;
  close(): Promise<void>;
}
