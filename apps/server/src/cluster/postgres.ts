import { randomUUID } from "node:crypto";
import pg from "pg";
import { HttpError } from "../errors";
import type { ClusterEvent, EventBus, ProjectLock } from "./types";

const CHANNEL = "ganttlines";
/** NOTIFY payloads must stay under 8000 bytes. */
const MAX_PAYLOAD = 7900;
const LOCK_NAMESPACE = 7102;

export type Log = (message: string, error?: unknown) => void;

/**
 * Postgres LISTEN/NOTIFY between copies: one listening connection per copy, notifications sent
 * through the shared pool. The copy pings itself through the channel: a connection that drops — or
 * goes quiet without closing (networks that silently drop idle connections) — is replaced, and a
 * resync is requested when it goes and again when it's back (events may have been missed).
 */
export class PgEventBus implements EventBus {
  readonly copyId = randomUUID();
  private client: pg.Client | null = null;
  private readonly handlers: ((event: ClusterEvent, from: string) => void)[] = [];
  private readonly resyncHandlers: (() => void)[] = [];
  private closing = false;
  private retryMs = 250;
  /** when the listener last heard anything (its own pings included) */
  private heard = Date.now();
  private watchdog: NodeJS.Timeout | undefined;
  private readonly pingMs: number;
  private readonly quietMs: number;

  constructor(
    private readonly databaseUrl: string,
    private readonly pool: pg.Pool,
    private readonly log: Log,
    { pingMs = 20_000, quietMs = 60_000 }: { pingMs?: number; quietMs?: number } = {},
  ) {
    this.pingMs = pingMs;
    this.quietMs = quietMs;
  }

  get ready(): boolean {
    return this.client !== null;
  }

  async start(): Promise<void> {
    await this.listen();
    this.watchdog = setInterval(() => {
      const client = this.client;
      if (client && Date.now() - this.heard > this.quietMs) {
        this.log("cluster: the listener stopped hearing anything; reconnecting");
        this.dropped(client);
        void client.end().catch(() => undefined);
        return;
      }
      void this.pool.query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify({ from: this.copyId, ping: true })]).catch(() => undefined);
    }, this.pingMs);
    this.watchdog.unref();
  }

  notification(event: ClusterEvent): { sql: string; params: unknown[] } {
    return { sql: "SELECT pg_notify($1, $2)", params: [CHANNEL, JSON.stringify({ from: this.copyId, event })] };
  }

  async publish(event: ClusterEvent): Promise<void> {
    const payload = JSON.stringify({ from: this.copyId, event });
    if (Buffer.byteLength(payload) > MAX_PAYLOAD) return this.log(`cluster: "${event.type}" event too large to send (${payload.length} bytes)`);
    try {
      await this.pool.query("SELECT pg_notify($1, $2)", [CHANNEL, payload]);
    } catch (error) {
      this.log(`cluster: couldn't send "${event.type}"`, error);
    }
  }

  subscribe(handler: (event: ClusterEvent, from: string) => void): void {
    this.handlers.push(handler);
  }

  onResync(handler: () => void): void {
    this.resyncHandlers.push(handler);
  }

  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.watchdog);
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => undefined);
  }

  private async listen(): Promise<void> {
    const client = new pg.Client({ connectionString: this.databaseUrl, application_name: "ganttlines-listener", keepAlive: true });
    client.on("notification", (message) => this.receive(message.payload));
    client.on("error", (error) => this.log("cluster: listener connection failed", error));
    client.on("end", () => this.dropped(client));
    await client.connect();
    try {
      await client.query(`LISTEN ${CHANNEL}`);
    } catch (error) {
      await client.end().catch(() => undefined); // don't leave the connection behind
      throw error;
    }
    this.heard = Date.now();
    this.client = client;
  }

  /** The listener is gone: ask for a resync now (browsers catch up) and reconnect. */
  private dropped(client: pg.Client): void {
    if (this.client !== client) return;
    this.client = null;
    if (!this.closing) for (const handler of this.resyncHandlers) handler();
    this.reconnect();
  }

  private reconnect(): void {
    if (this.closing) return;
    setTimeout(() => {
      if (this.closing) return;
      this.listen().then(
        () => {
          this.retryMs = 250;
          for (const handler of this.resyncHandlers) handler();
        },
        (error: unknown) => {
          this.log("cluster: couldn't reconnect the listener, retrying", error);
          this.retryMs = Math.min(this.retryMs * 2, 10_000);
          this.reconnect();
        },
      );
    }, this.retryMs).unref();
  }

  private receive(payload: string | undefined): void {
    if (!payload) return;
    this.heard = Date.now();
    let parsed: { from: string; event?: ClusterEvent; ping?: true };
    try {
      parsed = JSON.parse(payload) as typeof parsed;
    } catch {
      return;
    }
    if (parsed.from === this.copyId || !parsed.event) return;
    for (const handler of this.handlers) {
      try {
        handler(parsed.event, parsed.from);
      } catch (error) {
        this.log(`cluster: handling "${parsed.event.type}" failed`, error);
      }
    }
  }
}

/** Postgres' "lock_not_available": a lock wait ran past lock_timeout. */
const LOCK_NOT_AVAILABLE = "55P03";

/**
 * Advisory locks held on a pooled session for the length of the work (closing it releases them).
 * Waiting for one gives up after `waitMs` with a "busy" answer, so work stuck elsewhere doesn't
 * pile up requests (and connections) behind it.
 */
export class PgLock implements ProjectLock {
  private readonly waitMs: number;

  constructor(
    private readonly pool: pg.Pool,
    { waitMs = 30_000 }: { waitMs?: number } = {},
  ) {
    this.waitMs = Math.round(waitMs);
  }

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let healthy = true;
    // While the lock is held, nothing else listens for this connection's errors (a dropped
    // connection would otherwise crash the server); a broken one is thrown away on release.
    const broken = () => {
      healthy = false;
    };
    client.on("error", broken);
    try {
      await client.query(`SET lock_timeout = ${this.waitMs}`);
      await client.query("SELECT pg_advisory_lock($1, hashtext($2))", [LOCK_NAMESPACE, key]).catch((error: unknown) => {
        if ((error as { code?: string }).code === LOCK_NOT_AVAILABLE) throw new HttpError(503, "busy", "This is busy right now — try again in a moment");
        healthy = false;
        throw error;
      });
      try {
        return await work();
      } finally {
        // A session that couldn't unlock is thrown away (closing it releases the lock).
        await client.query("SELECT pg_advisory_unlock($1, hashtext($2))", [LOCK_NAMESPACE, key]).catch(() => {
          healthy = false;
        });
      }
    } finally {
      client.off("error", broken);
      client.release(!healthy);
    }
  }

  /** Runs `work` only if no other copy holds the lock right now. */
  async tryRun<T>(key: string, work: () => Promise<T>): Promise<T | undefined> {
    const client = await this.pool.connect();
    let healthy = true;
    const broken = () => {
      healthy = false;
    };
    client.on("error", broken);
    try {
      const { rows } = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1, hashtext($2)) AS ok", [LOCK_NAMESPACE, key]);
      if (!rows[0]?.ok) return undefined;
      try {
        return await work();
      } finally {
        await client.query("SELECT pg_advisory_unlock($1, hashtext($2))", [LOCK_NAMESPACE, key]).catch(broken);
      }
    } finally {
      client.off("error", broken);
      client.release(!healthy);
    }
  }
}
