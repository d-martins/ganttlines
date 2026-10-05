import { ClientMessage, toEngineCommand } from "@ganttlines/protocol";
import type { FastifyInstance } from "fastify";
import type { RawData } from "ws";
import type { ProjectAccess } from "../auth/access";
import { pendingStepOf, requireUser } from "../auth/guard";
import { credentialsOf, requireInstanceRead } from "../auth/request-access";
import { HttpError } from "../errors";
import { CLOSE_SESSION_ENDED, type Connection } from "../realtime/hub";
import type { RouteContext } from "./context";

/** Cached projects nobody has open are dropped after this long. */
const IDLE_EVICTION_MS = 10 * 60 * 1000;
/** A connection with more unhandled messages than this is flooding the server and gets closed. */
export const MAX_PENDING_MESSAGES = 100;
/** WebSocket close code for policy violations. */
const CLOSE_POLICY_VIOLATION = 1008;

/**
 * The live-editing WebSocket. Signed-in viewers (and above) join one project at a time, get
 * caught up, then receive every patch; editors send commands and undo/redo through it.
 */
export function realtimeRoutes(app: FastifyInstance, context: RouteContext, { revalidateMs }: { revalidateMs: number }): void {
  const { projects, instance, hub, access, presence, sessions, cluster } = context;
  const shared = cluster.mode === "postgres";

  /**
   * With several copies, a sign-out or demotion on another copy reaches this one as a notification —
   * which could be lost. So a connection's person is read again from the database (closing it when
   * the session is gone); returns false when it was closed.
   */
  const refresh = async (connection: Connection): Promise<boolean> => {
    if (!shared || !connection.sessionToken) return true;
    const session = await sessions.resolve(connection.sessionToken);
    if (!session) {
      hub.close(connection, CLOSE_SESSION_ENDED, "Session ended");
      return false;
    }
    connection.credentials = { ...connection.credentials, user: session.user, pendingStep: await pendingStepOf(context, session.user, session.viaSso) };
    return true;
  };

  // …and every connection is checked now and then (sessions in one query, without extending them),
  // so ones nobody uses don't outlive their session or link.
  if (shared) {
    const check = async () => {
      const open = hub.all().filter((connection) => !connection.closed);
      const tokens = open.flatMap((connection) => (connection.sessionToken ? [connection.sessionToken] : []));
      const live = tokens.length ? await sessions.check(tokens) : new Map();
      for (const connection of open) {
        if (connection.sessionToken) {
          const session = live.get(connection.sessionToken);
          if (!session) {
            hub.close(connection, CLOSE_SESSION_ENDED, "Session ended");
            continue;
          }
          connection.credentials = { ...connection.credentials, user: session.user, pendingStep: await pendingStepOf(context, session.user, session.viaSso) };
        }
        // Can this person (or link) still see the board it shows? Checked afresh, not by comparing.
        const projectId = connection.projectId;
        if (!projectId) continue;
        const granted = await access.resolve(connection.credentials, projectId).catch((error: unknown) => error);
        if (!isAccess(granted) && connection.projectId === projectId) hub.close(connection, CLOSE_SESSION_ENDED, "Access changed");
      }
    };
    const sweep = setInterval(() => void check().catch((error: unknown) => app.log.error(error)), revalidateMs);
    sweep.unref();
    app.addHook("onClose", async () => clearInterval(sweep));
  }
  const announcePresence = (projectId: string) => {
    presence.changed(projectId);
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
    // The server may have closed this connection (logout, role change…) while the message waited.
    if (connection.closed || connection.socket.readyState !== connection.socket.OPEN) return;
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
    if (!(await refresh(connection))) return;

    if (message.type === "join") {
      leave(connection);
      const granted = await access.resolve(connection.credentials, message.projectId).catch((error: unknown) => error);
      if (!isAccess(granted)) {
        const text = granted instanceof HttpError && granted.status < 500 ? granted.message : "Could not open the project";
        return hub.send(connection, { type: "error", message: text });
      }
      connection.viewer = { id: granted.key, name: granted.actor.label };
      connection.linkId = granted.linkId;
      // Join first so no live patch is missed; clients ignore versions they already have.
      connection.projectId = message.projectId;
      try {
        const { version: instanceVersion } = await instance.current();
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
          instanceVersion,
          viewers: presence.viewers(message.projectId),
        });
        announcePresence(message.projectId);
      } catch (error) {
        connection.projectId = null;
        const known = error instanceof HttpError && error.status < 500;
        hub.send(connection, { type: "error", message: known ? error.message : "Could not open the project" });
      }
      return;
    }

    const projectId = connection.projectId;
    const reject = (error: string, text: string) => hub.send(connection, { type: "reject", commandId: message.commandId, error, message: text });
    if (!projectId) return reject("invalid", "Join a project first");
    // Re-checked for every message: a link's collaboration setting can change while connected.
    const granted = await access.resolve(connection.credentials, projectId).catch((error: unknown) => error);
    if (!isAccess(granted) || !granted.canEdit) return reject("forbidden", "You can only view this project");
    try {
      const actor = granted.actor;
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
        const share = shareTokenOf(request.query);
        if (share) await requireInstanceRead(request, context, share);
        else requireUser(request, "viewer");
      },
    },
    (socket, request) => {
      const share = shareTokenOf(request.query);
      const connection: Connection = {
        socket,
        credentials: credentialsOf(request, access, share),
        sessionToken: request.sessionToken,
        linkId: null,
        viewer: null,
        projectId: null,
        closed: false,
        pending: 0,
      };
      hub.add(connection);
      // One message at a time per connection, so a join always completes before the next command.
      let queue = Promise.resolve();
      socket.on("message", (raw: RawData) => {
        if (connection.closed) return;
        if (connection.pending >= MAX_PENDING_MESSAGES) return hub.close(connection, CLOSE_POLICY_VIOLATION, "Too many pending messages");
        connection.pending++;
        queue = queue
          .then(() => handle(connection, raw))
          .catch((error: unknown) => app.log.error(error))
          .finally(() => connection.pending--);
      });
      socket.on("close", () => {
        hub.remove(connection);
        leave(connection);
      });
    },
  );
}

function shareTokenOf(query: unknown): string | null {
  const share = (query as { share?: unknown } | null)?.share;
  return typeof share === "string" && share.length > 0 ? share : null;
}

function isAccess(value: unknown): value is ProjectAccess {
  return typeof value === "object" && value !== null && "canEdit" in value;
}
