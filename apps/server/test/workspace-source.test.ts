import { createApi, ServerSource, type FetchLike, type SocketLike } from "@ganttlines/client";
import { workspaceContract } from "@ganttlines/client/testing";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { describe } from "vitest";
import { PUBLIC_URL, setupAdmin, useTestApp } from "./helpers";

const t = useTestApp();

/** REST through Fastify's in-memory injector, as the signed-in person. */
const injectedFetch =
  (app: FastifyInstance, cookie: string): FetchLike =>
  async (path, init) => {
    const response = await app.inject({ method: init.method, url: path, headers: { ...init.headers, cookie }, ...(init.body === undefined ? {} : { payload: init.body }) });
    return { status: response.statusCode, ok: response.statusCode < 400, statusText: response.statusMessage, json: async () => response.json() };
  };

/** The board link over Fastify's in-memory WebSocket, shaped like a browser WebSocket. */
function injectedLink(app: FastifyInstance, cookie: string): SocketLike {
  let socket: WebSocket | null = null;
  const link: { -readonly [K in keyof SocketLike]: SocketLike[K] } = {
    readyState: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    send: (data) => socket?.send(data),
    close: () => socket?.close(),
  };
  void app.injectWS("/ws", { headers: { cookie, origin: PUBLIC_URL } }).then((opened) => {
    socket = opened;
    link.readyState = 1;
    opened.on("message", (data) => link.onmessage?.({ data: data.toString() }));
    opened.on("close", (code) => {
      link.readyState = 3;
      link.onclose?.({ code });
    });
    link.onopen?.();
  });
  return link;
}

describe("the server as a workspace source", () => {
  workspaceContract(async () => {
    const cookie = await setupAdmin(t.app);
    return new ServerSource({ api: createApi(injectedFetch(t.app, cookie)), openLink: () => injectedLink(t.app, cookie) });
  });
});
