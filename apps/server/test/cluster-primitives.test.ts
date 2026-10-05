import { describe, expect, inject, it } from "vitest";
import { holdModeGuard } from "../src/cluster/mode-guard";

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
