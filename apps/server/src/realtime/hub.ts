import type { User } from "@ganttlines/db";
import type { ServerMessage, Viewer } from "@ganttlines/protocol";
import type { WebSocket } from "ws";

/** Close code sent when a user's session ends or their access changes; the client should re-authenticate. */
export const CLOSE_SESSION_ENDED = 4001;

export interface Connection {
  socket: WebSocket;
  user: User;
  sessionToken: string | null;
  /** The project this connection currently shows (one at a time). */
  projectId: string | null;
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

  /** Distinct users currently viewing a project, in the order they joined. */
  viewers(projectId: string): Viewer[] {
    const viewers = new Map<string, Viewer>();
    for (const { projectId: joined, user } of this.connections) {
      if (joined === projectId && !viewers.has(user.id)) viewers.set(user.id, { userId: user.id, name: user.name });
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
    this.closeWhere((c) => c.user.id === userId && (exceptSessionToken == null || c.sessionToken !== exceptSessionToken));
  }

  closeSession(sessionToken: string): void {
    this.closeWhere((c) => c.sessionToken === sessionToken);
  }

  private closeWhere(predicate: (connection: Connection) => boolean): void {
    for (const connection of [...this.connections]) {
      if (predicate(connection)) connection.socket.close(CLOSE_SESSION_ENDED, "Session ended");
    }
  }
}
