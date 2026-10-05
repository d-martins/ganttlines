import pg from "pg";
import { describe, expect, inject, it } from "vitest";
import { holdModeGuard } from "../src/cluster/mode-guard";
import { PgEventBus, PgLock } from "../src/cluster/postgres";
import type { ClusterEvent } from "../src/cluster/types";

describe("mode guard", () => {
  const url = () => inject("databaseUrl");

  it("lets postgres-mode copies share the database, but never with a single-mode one", async () => {
    const a = await holdModeGuard(url(), "postgres");
    const b = await holdModeGuard(url(), "postgres");
    await expect(holdModeGuard(url(), "single")).rejects.toThrow(
      "Several GanttLines servers are using this database. Set CLUSTER=postgres on all of them (or run just one).",
    );
    await Promise.all([a.release(), b.release()]);

    const single = await holdModeGuard(url(), "single");
    await expect(holdModeGuard(url(), "single")).rejects.toThrow("Another GanttLines server is already using this database");
    await expect(holdModeGuard(url(), "postgres")).rejects.toThrow("A GanttLines server in single mode is already using this database");
    await single.release();
    await (await holdModeGuard(url(), "single")).release(); // released: free again
  });
});

const quiet = () => undefined;

async function busPair() {
  const pool = new pg.Pool({ connectionString: inject("databaseUrl"), max: 4 });
  const a = new PgEventBus(inject("databaseUrl"), pool, quiet);
  const b = new PgEventBus(inject("databaseUrl"), pool, quiet);
  await Promise.all([a.start(), b.start()]);
  const close = async () => {
    await Promise.all([a.close(), b.close()]);
    await pool.end();
  };
  return { a, b, pool, close };
}

const received = (bus: PgEventBus) => {
  const events: { event: ClusterEvent; from: string }[] = [];
  bus.subscribe((event, from) => events.push({ event, from }));
  return events;
};

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(check()).toBe(true);
};

describe("event bus (postgres)", () => {
  it("delivers each copy's events to the others, in order, never to itself", async () => {
    const { a, b, close } = await busPair();
    const atA = received(a);
    const atB = received(b);
    for (let version = 1; version <= 3; version++) await a.publish({ type: "patch", projectId: "p", version });
    await until(() => atB.length === 3);
    expect(atB.map(({ event }) => (event as { version: number }).version)).toEqual([1, 2, 3]);
    expect(atB[0]!.from).toBe(a.copyId);
    expect(atA).toEqual([]);
    await close();
  });

  it("skips events too big for a notification", async () => {
    const { a, b, close } = await busPair();
    const atB = received(b);
    await a.publish({ type: "presence", projectId: "p", viewers: Array.from({ length: 400 }, (_, i) => ({ id: `user:${i}`, name: "x".repeat(30) })) });
    await a.publish({ type: "alive" });
    await until(() => atB.length === 1);
    expect(atB[0]!.event.type).toBe("alive");
    await close();
  });

  it("reconnects when its connection drops, and asks for a resync", async () => {
    const { a, b, pool, close } = await busPair();
    const atB = received(b);
    let resyncs = 0;
    b.onResync(() => resyncs++);
    await pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'ganttlines-listener' AND pid <> pg_backend_pid()");
    await until(() => resyncs >= 1 && b.ready);
    await a.publish({ type: "alive" });
    await until(() => atB.length === 1);
    await close();
  });
});

describe("project lock (postgres)", () => {
  it("makes work on one key take turns across lock instances, and leaves other keys free", async () => {
    const pools = [new pg.Pool({ connectionString: inject("databaseUrl"), max: 2 }), new pg.Pool({ connectionString: inject("databaseUrl"), max: 2 })];
    const [one, two] = pools.map((pool) => new PgLock(pool));
    const log: string[] = [];
    const step = (lock: PgLock, key: string, name: string) =>
      lock.run(key, async () => {
        log.push(`${name} in`);
        await new Promise((resolve) => setTimeout(resolve, 50));
        log.push(`${name} out`);
      });
    await Promise.all([step(one!, "project:x", "A"), step(two!, "project:x", "B")]);
    expect([log.slice(0, 2), log.slice(2)].map((pair) => pair[0]!.slice(0, 1) === pair[1]!.slice(0, 1))).toEqual([true, true]);
    log.length = 0;
    await Promise.all([step(one!, "project:x", "A"), step(two!, "project:y", "B")]);
    expect(log.slice(0, 2).sort()).toEqual(["A in", "B in"]); // different projects don't wait
    await Promise.all(pools.map((pool) => pool.end()));
  });
});
