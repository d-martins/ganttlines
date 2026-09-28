import { ClientMessage, toEngineCommand } from "@ganttlines/protocol";
import type { FastifyInstance } from "fastify";
import type { RawData } from "ws";
import { actorOf } from "../actor";
import { requireUser } from "../auth/guard";
import { HttpError } from "../errors";
import type { Connection } from "../realtime/hub";
import type { RouteContext } from "./context";

/** Cached projects nobody has open are dropped after this long. */
const IDLE_EVICTION_MS = 10 * 60 * 1000;

/**
 * The live-editing WebSocket. Signed-in viewers (and above) join one project at a time, get
 * caught up, then receive every patch; editors send commands and undo/redo through it.
 */
export function realtimeRoutes(app: FastifyInstance, { projects, instance, hub }: RouteContext): void {
  const announcePresence = (projectId: string) => {
    hub.broadcast(projectId, { type: "presence", projectId, viewers: hub.viewers(projectId) });
    if (hub.roomSize(projectId) === 0) {
      setTimeout(() => {
        if (hub.roomSize(projectId) === 0) void projects.evict(projectId);
      }, IDLE_EVICTION_MS).unref();
    }
  };

  const leave = (connection: Connection) => {
    const previous = connection.projectId;
    connection.projectId = null;
    if (previous) announcePresence(previous);
  };

  const handle = async (connection: Connection, raw: RawData) => {
    let json: unknown;
    try {
      json = JSON.parse(raw.toString());
    } catch {
      return hub.send(connection, { type: "error", message: "Messages must be JSON" });
    }
    const parsed = ClientMessage.safeParse(json);
    if (!parsed.success) return hub.send(connection, { type: "error", message: "Unknown or malformed message" });
    const message = parsed.data;

    if (message.type === "leave") return leave(connection);

    if (message.type === "join") {
      leave(connection);
      // Join first so no live patch is missed; clients ignore versions they already have.
      connection.projectId = message.projectId;
      try {
        const catchUp = await projects.changesSince(message.projectId, message.version);
        if ("reload" in catchUp) {
          hub.send(connection, { type: "reload", projectId: message.projectId });
        } else {
          for (const entry of catchUp.entries) hub.send(connection, { type: "patch", projectId: message.projectId, ...entry });
        }
        hub.send(connection, {
          type: "joined",
          projectId: message.projectId,
          version: catchUp.version,
          instanceVersion: (await instance.current()).version,
          viewers: hub.viewers(message.projectId),
        });
        announcePresence(message.projectId);
      } catch (error) {
        connection.projectId = null;
        hub.send(connection, { type: "error", message: error instanceof HttpError ? error.message : "Could not open the project" });
      }
      return;
    }

    const projectId = connection.projectId;
    const reject = (error: string, text: string) => hub.send(connection, { type: "reject", commandId: message.commandId, error, message: text });
    if (!projectId) return reject("invalid", "Join a project first");
    if (connection.user.role !== "editor" && connection.user.role !== "admin") return reject("forbidden", "You can only view this project");
    try {
      const actor = actorOf(connection.user);
      if (message.type === "command") {
        const result = await projects.apply(projectId, actor, message.commandId, toEngineCommand(message.command));
        hub.send(connection, { type: "ack", commandId: message.commandId, version: result.version });
      } else {
        const result = await projects[message.type](projectId, actor, message.commandId);
        hub.send(connection, { type: "ack", commandId: message.commandId, version: result.version, skipped: result.skipped });
      }
    } catch (error) {
      if (error instanceof HttpError) return reject(error.code, error.message);
      app.log.error(error);
      reject("internal", "Something went wrong");
    }
  };

  app.get(
    "/ws",
    {
      websocket: true,
      preValidation: async (request) => {
        requireUser(request, "viewer");
      },
    },
    (socket, request) => {
      const connection: Connection = { socket, user: request.user!, sessionToken: request.sessionToken, projectId: null };
      hub.add(connection);
      // One message at a time per connection, so a join always completes before the next command.
      let pending = Promise.resolve();
      socket.on("message", (raw: RawData) => {
        pending = pending.then(() => handle(connection, raw)).catch((error: unknown) => app.log.error(error));
      });
      socket.on("close", () => {
        hub.remove(connection);
        leave(connection);
      });
    },
  );
}
