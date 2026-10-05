import type { ServerMessage, Viewer } from "@ganttlines/protocol";
import { createHash } from "node:crypto";
import type { WebSocket } from "ws";
import type { Credentials } from "../auth/access";

/** Close code sent when a session ends or access changes; the client should re-authenticate. */
export const CLOSE_SESSION_ENDED = 4001;
/** The project was deleted: its boards close for good. */
export const CLOSE_PROJECT_DELETED = 4004;

/** A session token's digest: what copies tell each other (tokens never leave the copy). */
export const sessionDigest = (token: string) => createHash("sha256").update(token).digest("hex");

export interface Connection {
  socket: WebSocket;
  /** what the socket authenticated with (user session, share token, anonymous visitor) */
  credentials: Credentials;
  sessionToken: string | null;
  /** the share link the socket uses, if any (revoking it closes the socket) */
  linkId: string | null;
  /** who this connection is in presence lists, once it has joined a project */
  viewer: Viewer | null;
  /** The project this connection currently shows (one at a time). */
  projectId: string | null;
  /** Set as soon as the server decides to close it; queued messages are then dropped. */
  closed: boolean;
  /** Messages received but not handled yet (bounded). */
  pending: number;
}

/** All open WebSocket connections, grouped into project rooms. */
export class Hub {
  private readonly connections = new Set<Connection>();

  add(connection: Connection): void {
    this.connections.add(connection);
  }

  remove(connection: Connection): void {
    this.connections.delete(connection);
  }

  send(connection: Connection, message: ServerMessage): void {
    if (connection.socket.readyState === connection.socket.OPEN) connection.socket.send(JSON.stringify(message));
  }

  broadcast(projectId: string, message: ServerMessage): void {
    for (const connection of this.connections) if (connection.projectId === projectId) this.send(connection, message);
  }

  /** Like `broadcast`, but the message is built per connection (e.g. "is this comment mine?"). */
  broadcastEach(projectId: string, message: (connection: Connection) => ServerMessage): void {
    for (const connection of this.connections) if (connection.projectId === projectId) this.send(connection, message(connection));
  }

  broadcastAll(message: ServerMessage): void {
    for (const connection of this.connections) this.send(connection, message);
  }

  /** Distinct people (users and anonymous visitors) currently viewing a project, in join order. */
  viewers(projectId: string): Viewer[] {
    const viewers = new Map<string, Viewer>();
    for (const { projectId: joined, viewer } of this.connections) {
      if (joined === projectId && viewer && !viewers.has(viewer.id)) viewers.set(viewer.id, viewer);
    }
    return [...viewers.values()];
  }

  roomSize(projectId: string): number {
    let size = 0;
    for (const connection of this.connections) if (connection.projectId === projectId) size++;
    return size;
  }

  /** Closes every connection of a user (optionally keeping those of one session). */
  closeUser(userId: string, exceptSessionToken?: string | null): void {
    this.closeWhere(
      (c) => c.credentials.user?.id === userId && (exceptSessionToken == null || c.sessionToken !== exceptSessionToken),
    );
  }

  closeSession(sessionToken: string): void {
    this.closeWhere((c) => c.sessionToken === sessionToken);
  }

  /** Closes a user's connections except those of one session (given by digest). */
  closeUserExceptDigest(userId: string, exceptDigest: string | null): void {
    this.closeWhere(
      (c) => c.credentials.user?.id === userId && (exceptDigest === null || c.sessionToken === null || sessionDigest(c.sessionToken) !== exceptDigest),
    );
  }

  closeSessionDigest(digest: string): void {
    this.closeWhere((c) => c.sessionToken !== null && sessionDigest(c.sessionToken) === digest);
  }

  /** Projects with at least one viewer on this copy. */
  rooms(): string[] {
    return [...new Set([...this.connections].flatMap((c) => (c.projectId && c.viewer ? [c.projectId] : [])))];
  }

  /** Closes every connection with `code` (e.g. 1012: reconnect and catch up). */
  closeAll(code: number, reason: string): void {
    for (const connection of [...this.connections]) this.close(connection, code, reason);
  }

  /** Closes every connection that uses a (revoked) share link. */
  closeLink(linkId: string): void {
    this.closeWhere((c) => c.linkId === linkId);
  }

  /** Closes every connection showing a project (it was deleted). */
  closeProject(projectId: string): void {
    for (const connection of [...this.connections]) {
      if (connection.projectId === projectId) this.close(connection, CLOSE_PROJECT_DELETED, "Project deleted");
    }
  }

  /** Stops the connection immediately (no further messages are handled) and closes the socket. */
  close(connection: Connection, code: number, reason: string): void {
    connection.closed = true;
    connection.projectId = null;
    connection.socket.close(code, reason);
  }

  private closeWhere(predicate: (connection: Connection) => boolean): void {
    for (const connection of [...this.connections]) {
      if (predicate(connection)) this.close(connection, CLOSE_SESSION_ENDED, "Session ended");
    }
  }
}
