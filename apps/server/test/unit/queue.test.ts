import { describe, expect, it } from "vitest";
import { KeyedQueue } from "../../src/queue";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("KeyedQueue", () => {
  it("runs tasks for the same key one at a time, in order", async () => {
    const queue = new KeyedQueue();
    const log: string[] = [];
    const task = (name: string) => async () => {
      log.push(`start ${name}`);
      await tick();
      log.push(`end ${name}`);
      return name;
    };
    const results = await Promise.all([queue.run("p", task("a")), queue.run("p", task("b"))]);
    expect(results).toEqual(["a", "b"]);
    expect(log).toEqual(["start a", "end a", "start b", "end b"]);
  });

  it("runs different keys concurrently", async () => {
    const queue = new KeyedQueue();
    const log: string[] = [];
    const task = (name: string) => async () => {
      log.push(`start ${name}`);
      await tick();
      log.push(`end ${name}`);
    };
    await Promise.all([queue.run("p1", task("a")), queue.run("p2", task("b"))]);
    expect(log.slice(0, 2)).toEqual(["start a", "start b"]);
  });

  it("keeps going after a failing task", async () => {
    const queue = new KeyedQueue();
    const failing = queue.run("p", async () => {
      throw new Error("boom");
    });
    const next = queue.run("p", async () => "ok");
    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });
});
