import type { ServerMessage } from "@ganttlines/protocol";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { PUBLIC_URL } from "./helpers";

export interface TestClient {
  ws: WebSocket;
  send(message: object): void;
  /** Resolves with the next received message of `type` (optionally matching `where`), consuming it. */
  next<T extends ServerMessage["type"]>(type: T, where?: (message: Extract<ServerMessage, { type: T }>) => boolean): Promise<Extract<ServerMessage, { type: T }>>;
  /** Messages received and not yet consumed by `next`. */
  inbox: ServerMessage[];
  closed: Promise<number>;
}

/** Opens a WebSocket to /ws through Fastify's in-memory injector. */
export async function connect(app: FastifyInstance, cookie: string, origin = PUBLIC_URL): Promise<TestClient> {
  const inbox: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  let resolveClosed!: (code: number) => void;
  const closed = new Promise<number>((resolve) => (resolveClosed = resolve));
  await app.ready();
  const ws = await app.injectWS("/ws", { headers: { cookie, origin } }, {
    onInit: (socket) => {
      socket.on("message", (data) => {
        inbox.push(JSON.parse(data.toString()) as ServerMessage);
        for (const wake of waiters.splice(0)) wake();
      });
      socket.on("close", (code) => resolveClosed(code));
    },
  });
  const next: TestClient["next"] = async (type, where) => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const index = inbox.findIndex((m) => m.type === type && (!where || where(m as never)));
      if (index >= 0) return inbox.splice(index, 1)[0] as never;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for "${type}"; inbox: ${JSON.stringify(inbox)}`);
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  };
  return { ws, send: (message) => ws.send(JSON.stringify(message)), next, inbox, closed };
}
