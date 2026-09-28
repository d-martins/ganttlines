import type { ServerMessage, Viewer } from "@ganttlines/protocol";
import type { WebSocket } from "ws";
import type { Credentials } from "../auth/access";

/** Close code sent when a session ends or access changes; the client should re-authenticate. */
export const CLOSE_SESSION_ENDED = 4001;

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

  /** Closes every connection that uses a (revoked) share link. */
  closeLink(linkId: string): void {
    this.closeWhere((c) => c.linkId === linkId);
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
