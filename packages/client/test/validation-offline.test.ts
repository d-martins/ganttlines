import type { ServerMessage } from "@ganttlines/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("zod");
  vi.resetModules();
});

describe("when the request checks can't be loaded (offline, or the site was updated meanwhile)", () => {
  it("rejects the edit instead of leaving it unanswered, and tries loading again next time", async () => {
    vi.resetModules();
    let loads = 0;
    vi.doMock("zod", async (importOriginal) => {
      if (loads++ === 0) throw new Error("Failed to fetch dynamically imported module");
      return importOriginal();
    });
    const offline = await import("../src/local/local-source");
    const offlineSource = await offline.LocalSource.open(new (await import("../src/local/store")).MemoryStore());
    const offlineLink = offlineSource.openBoard("11111111-1111-4111-8111-111111111111").openLink();
    const offlineReceived: ServerMessage[] = [];
    offlineLink.onmessage = (event) => offlineReceived.push(JSON.parse(String(event.data)) as ServerMessage);
    await new Promise((resolve) => setTimeout(resolve, 10));
    offlineLink.send(JSON.stringify({ type: "undo", commandId: "22222222-2222-4222-8222-222222222222" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(offlineReceived).toEqual([expect.objectContaining({ type: "reject", commandId: "22222222-2222-4222-8222-222222222222", error: "unavailable" })]);

    await expect(offlineSource.createProject({ name: "Back online" })).resolves.toMatchObject({ name: "Back online" });
  });
});
