import { TASK_DEFAULTS, type RowChange, type TaskRow } from "@ganttlines/engine";
import type { ProjectStateDto, ServerMessage } from "@ganttlines/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardSync, type SocketLike } from "../src/sync/board-sync";

const PROJECT = "11111111-1111-4111-8111-111111111111";

export function task(id: string, fields: Partial<TaskRow> = {}): TaskRow {
  return { ...TASK_DEFAULTS, id, kind: "task", title: id, parentId: null, position: "a0", collapsed: false, ...fields };
}

function stateDto(version: number, rows = [task("a")]): ProjectStateDto {
  return { project: { id: PROJECT, name: "Launch", version, archived: false }, rows };
}

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const retitle = (version: number, title: string, rowId = "a"): ServerMessage => ({
  type: "patch",
  projectId: PROJECT,
  version,
  commandId: `c${version}`,
  actor: { userId: null, label: "Ana" },
  changes: [{ rowId, field: "title", before: "?", after: title } satisfies RowChange],
});
const joined = (version: number): ServerMessage => ({ type: "joined", projectId: PROJECT, version, instanceVersion: 1, viewers: [] });

async function started(version = 3, load = vi.fn(async () => stateDto(version)), isFatal?: (error: unknown) => boolean) {
  const sockets: FakeSocket[] = [];
  const events: unknown[] = [];
  const sync = new BoardSync({
    projectId: PROJECT,
    loadState: load,
    openSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onEvent: (event) => events.push(event),
    backoff: { baseMs: 100, maxMs: 1000 },
    ...(isFatal ? { isFatal } : {}),
  });
  await sync.start();
  sockets[0]!.open();
  return { sync, sockets, events, load, title: () => (sync.state.confirmed.rows["a"] as TaskRow).title };
}

describe("BoardSync", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("loads the state, then joins with its version", async () => {
    const { sync, sockets } = await started(3);
    expect(sockets[0]!.sent).toEqual([{ type: "join", projectId: PROJECT, version: 3 }]);
    expect(sync.state.status).toBe("loading");
    sockets[0]!.deliver(joined(3));
    expect(sync.state.status).toBe("live");
  });

  it("applies patches in version order and ignores ones it already has", async () => {
    const { sync, sockets, title } = await started(3);
    const socket = sockets[0]!;
    socket.deliver(retitle(3, "old"));
    socket.deliver(retitle(4, "four"));
    socket.deliver(retitle(4, "again"));
    expect(title()).toBe("four");
    expect(sync.state.version).toBe(4);
  });

  it("holds gaps until joined, then fills them from the catch-up", async () => {
    const { sync, sockets, title } = await started(3);
    const socket = sockets[0]!;
    socket.deliver(retitle(5, "five")); // live patch overtook the catch-up
    expect(sync.state.version).toBe(3);
    socket.deliver(retitle(4, "four"));
    expect(title()).toBe("five");
    expect(sync.state.version).toBe(5);
    socket.deliver(joined(5));
    expect(socket.sent).toHaveLength(1);
  });

  it("joins again when a gap appears after joining", async () => {
    const { sync, sockets } = await started(3);
    const socket = sockets[0]!;
    socket.deliver(joined(3));
    socket.deliver(retitle(5, "five"));
    expect(sync.state.version).toBe(3);
    expect(socket.sent.at(-1)).toEqual({ type: "join", projectId: PROJECT, version: 3 });
  });

  it("refetches the state on reload and keeps newer held patches", async () => {
    const load = vi.fn(async () => stateDto(3));
    const { sync, sockets, title } = await started(3, load);
    const socket = sockets[0]!;
    load.mockResolvedValueOnce(stateDto(10, [{ ...task("a"), title: "ten" }]));
    socket.deliver({ type: "reload", projectId: PROJECT });
    socket.deliver(retitle(11, "eleven"));
    socket.deliver(joined(10));
    await vi.waitFor(() => expect(sync.state.version).toBe(11));
    expect(title()).toBe("eleven");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reconnects with backoff and rejoins from the local version", async () => {
    const { sync, sockets } = await started(3);
    sockets[0]!.deliver(retitle(4, "four"));
    sockets[0]!.drop();
    expect(sync.state.status).toBe("reconnecting");
    vi.advanceTimersByTime(99);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    sockets[1]!.open();
    expect(sockets[1]!.sent).toEqual([{ type: "join", projectId: PROJECT, version: 4 }]);
    sockets[1]!.drop(); // it had opened, so the delay starts over
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(3);
    sockets[2]!.drop(); // never opened: the delay doubles
    vi.advanceTimersByTime(199);
    expect(sockets).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(4);
  });

  it("never reconnects after the server ends the session or closes for flooding", async () => {
    for (const [code, reason] of [
      [4001, "signed_out"],
      [1008, "flooding"],
    ] as const) {
      const { sync, sockets } = await started(3);
      sockets[0]!.drop(code);
      vi.advanceTimersByTime(60_000);
      expect(sockets).toHaveLength(1);
      expect(sync.state).toMatchObject({ status: "ended", endReason: reason });
    }
  });

  it("re-checks access when a connection fails before opening, and ends on a fatal answer", async () => {
    const load = vi.fn(async () => stateDto(3));
    const { sync, sockets } = await started(3, load, (error) => error instanceof Error && error.message === "gone");
    sockets[0]!.drop(); // had opened: no check
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    load.mockRejectedValueOnce(new Error("offline"));
    sockets[1]!.drop(); // never opened, server still down: keep retrying
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(sync.state.status).toBe("reconnecting");
    vi.advanceTimersByTime(200);
    load.mockRejectedValueOnce(new Error("gone"));
    sockets[2]!.drop(); // refused: access is gone
    await vi.waitFor(() => expect(sync.state.status).toBe("ended"));
    expect(sync.state.loadError).toEqual(new Error("gone"));
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(3);
  });

  it("reports a failed first load and opens no socket", async () => {
    const sockets: SocketLike[] = [];
    const sync = new BoardSync({
      projectId: PROJECT,
      loadState: () => Promise.reject(new Error("gone")),
      openSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await sync.start();
    expect(sync.state.loadError).toBeInstanceOf(Error);
    expect(sockets).toHaveLength(0);
  });

  it("passes unversioned news on and ignores other projects", async () => {
    const { sync, sockets, events } = await started(3);
    const socket = sockets[0]!;
    socket.deliver(joined(3));
    socket.deliver({ type: "highlights", projectId: PROJECT, highlights: [] });
    socket.deliver({ type: "highlights", projectId: "other", highlights: [] });
    socket.deliver({ type: "presence", projectId: PROJECT, viewers: [{ id: "v", name: "Ana" }] });
    socket.deliver({ type: "project", project: { id: PROJECT, name: "Renamed", version: 3, archived: true } });
    expect(events).toEqual([{ type: "joined", instanceVersion: 1 }, { type: "highlights", projectId: PROJECT, highlights: [] }]);
    expect(sync.state.viewers).toEqual([{ id: "v", name: "Ana" }]);
    expect(sync.state.project?.name).toBe("Renamed");
  });

  it("stops cleanly: no reconnect after stop", async () => {
    const { sync, sockets } = await started(3);
    sync.stop();
    sockets[0]!.drop();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });
});
