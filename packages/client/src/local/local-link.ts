import type { ServerMessage } from "@ganttlines/protocol";
import type { SocketLike } from "../source";

const OPEN = 1;
const CLOSED = 3;

/**
 * A board's live link inside the browser, shaped like a WebSocket: it opens on the next tick,
 * hands what's sent to the local source, and delivers messages in order, asynchronously, as a
 * socket would.
 */
export class LocalLink implements SocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  /** the board this link has joined */
  projectId: string | null = null;

  constructor(
    private readonly received: (link: LocalLink, data: string) => void,
    private readonly ended: (link: LocalLink) => void,
  ) {
    void Promise.resolve().then(() => {
      if (this.readyState !== 0) return;
      this.readyState = OPEN;
      this.onopen?.();
    });
  }

  send(data: string): void {
    if (this.readyState === OPEN) this.received(this, data);
  }

  deliver(message: ServerMessage): void {
    if (this.readyState !== OPEN) return;
    const data = JSON.stringify(message);
    void Promise.resolve().then(() => this.onmessage?.({ data }));
  }

  close(code = 1000): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.ended(this);
    void Promise.resolve().then(() => this.onclose?.({ code }));
  }
}
