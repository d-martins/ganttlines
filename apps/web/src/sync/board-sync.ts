import { applyChanges, type ProjectState, type Row } from "@ganttlines/engine";
import type { ProjectDto, ProjectStateDto, ServerMessage, Viewer } from "@ganttlines/protocol";
import { createStore, type StoreApi } from "zustand/vanilla";

/** The parts of a WebSocket the sync client uses (a fake one stands in for tests). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
}

/**
 * - `loading`: fetching the project; `live`: joined and receiving patches;
 * - `reconnecting`: the connection dropped and is being retried (the board stays visible, read-only);
 * - `ended`: the server closed it for good (`endReason` says why); nothing reconnects.
 */
export type ConnectionStatus = "loading" | "live" | "reconnecting" | "ended";
export type EndReason = "signed_out" | "flooding";

export interface BoardState {
  status: ConnectionStatus;
  endReason: EndReason | null;
  /** set when the first load failed; the board cannot be shown */
  loadError: unknown;
  /** the server's message when joining failed (e.g. access was revoked meanwhile) */
  joinError: string | null;
  project: ProjectDto | null;
  /** server truth: advanced only by `/state` and by patches in strict version order */
  confirmed: ProjectState;
  version: number;
  viewers: Viewer[];
}

/** Unversioned news the board refetches or merges into its REST caches. */
export type BoardEvent =
  | { type: "joined"; instanceVersion: number }
  | Extract<ServerMessage, { type: "instance" | "comment" | "highlights" | "baselines" }>;

export interface BoardSyncOptions {
  projectId: string;
  loadState: () => Promise<ProjectStateDto>;
  openSocket: () => SocketLike;
  onEvent?: (event: BoardEvent) => void;
  /**
   * Whether a failed `loadState` means the board can't be shown at all (no access, deleted…).
   * Checked when a connection fails before opening: the server refuses WebSocket upgrades with a
   * plain HTTP status the browser can't see, so access is re-checked over REST instead.
   */
  isFatal?: (error: unknown) => boolean;
  /** reconnect delays; the n-th retry waits `min(base * 2^n, max)` */
  backoff?: { baseMs: number; maxMs: number };
}

const CLOSE_SIGNED_OUT = 4001;
const CLOSE_POLICY_VIOLATION = 1008;
const OPEN = 1;

type Patch = Extract<ServerMessage, { type: "patch" }>;

/**
 * Keeps one project's rows in step with the server (web spec §4): loads `/state`, joins over the
 * WebSocket, applies patches strictly in version order, holds gaps until caught up, rejoins on a
 * gap afterwards, and reconnects with backoff unless the server ended the session.
 */
export class BoardSync {
  readonly store: StoreApi<BoardState>;
  private socket: SocketLike | null = null;
  /** true between `joined` and the next (re)join or disconnect */
  private joined = false;
  /** true while `/state` is being refetched after `reload` */
  private reloading = false;
  private held = new Map<number, Patch>();
  private retries = 0;
  /** whether the current socket ever opened */
  private opened = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly options: BoardSyncOptions) {
    this.store = createStore<BoardState>(() => ({
      status: "loading",
      endReason: null,
      loadError: null,
      joinError: null,
      project: null,
      confirmed: { rows: {} },
      version: 0,
      viewers: [],
    }));
  }

  get projectId(): string {
    return this.options.projectId;
  }

  get state(): BoardState {
    return this.store.getState();
  }

  async start(): Promise<void> {
    try {
      this.adopt(await this.options.loadState());
    } catch (error) {
      if (!this.stopped) this.store.setState({ loadError: error, status: "ended" });
      return;
    }
    if (!this.stopped) this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.close();
    }
  }

  private adopt(dto: ProjectStateDto): void {
    const rows: Record<string, Row> = {};
    for (const row of dto.rows) rows[row.id] = row;
    this.store.setState({ project: dto.project, confirmed: { rows }, version: dto.project.version });
    this.drain();
  }

  private connect(): void {
    const socket = this.options.openSocket();
    this.socket = socket;
    socket.onopen = () => {
      this.opened = true;
      this.retries = 0;
      this.join();
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      this.receive(message);
    };
    socket.onclose = (event) => this.closed(event.code);
  }

  private join(): void {
    this.joined = false;
    this.send({ type: "join", projectId: this.options.projectId, version: this.state.version });
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(message));
  }

  private closed(code: number): void {
    const neverOpened = !this.opened;
    this.opened = false;
    this.socket = null;
    this.joined = false;
    this.held.clear();
    if (this.stopped) return;
    if (code === CLOSE_SIGNED_OUT || code === CLOSE_POLICY_VIOLATION) {
      this.store.setState({ status: "ended", endReason: code === CLOSE_SIGNED_OUT ? "signed_out" : "flooding", viewers: [] });
      return;
    }
    this.store.setState({ status: "reconnecting", viewers: [] });
    const { baseMs, maxMs } = this.options.backoff ?? { baseMs: 500, maxMs: 15_000 };
    const delay = Math.min(baseMs * 2 ** this.retries, maxMs);
    this.retries++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
    if (neverOpened) void this.checkAccess();
  }

  private async checkAccess(): Promise<void> {
    try {
      await this.options.loadState();
    } catch (error) {
      if (this.stopped || !this.options.isFatal?.(error)) return;
      this.stop();
      this.store.setState({ status: "ended", loadError: error, viewers: [] });
    }
  }

  /** Handles one server message (public so tests can drive the client without a socket). */
  receive(message: ServerMessage): void {
    if ("projectId" in message && message.projectId !== this.options.projectId) return;
    switch (message.type) {
      case "patch":
        return this.patch(message);
      case "joined":
        this.joined = true;
        this.store.setState({ status: "live", joinError: null, viewers: message.viewers });
        this.drain();
        this.options.onEvent?.({ type: "joined", instanceVersion: message.instanceVersion });
        return;
      case "reload":
        return void this.reload();
      case "presence":
        return this.store.setState({ viewers: message.viewers });
      case "project":
        if (message.project.id === this.options.projectId) this.store.setState({ project: message.project });
        return;
      case "error":
        // The only error a read-only board can cause is a failed join (e.g. access removed meanwhile).
        return this.store.setState({ joinError: message.message });
      case "instance":
      case "comment":
      case "highlights":
      case "baselines":
        return this.options.onEvent?.(message);
      default:
        return;
    }
  }

  private patch(message: Patch): void {
    if (message.version <= this.state.version) return;
    this.held.set(message.version, message);
    this.drain();
  }

  /** Applies held patches in order; after catching up, a remaining gap means one was missed. */
  private drain(): void {
    let { confirmed, version } = this.state;
    const start = version;
    for (let next = this.held.get(version + 1); next; next = this.held.get(version + 1)) {
      this.held.delete(next.version);
      confirmed = applyChanges(confirmed, next.changes);
      version = next.version;
    }
    for (const stale of this.held.keys()) if (stale <= version) this.held.delete(stale);
    if (version !== start) this.store.setState({ confirmed, version });
    if (this.held.size > 0 && this.joined && !this.reloading) {
      this.held.clear();
      this.join();
    }
  }

  private async reload(): Promise<void> {
    this.reloading = true;
    try {
      const dto = await this.options.loadState();
      if (this.stopped) return;
      this.reloading = false;
      // Patches older than the fresh state are already part of it (`adopt` drops them).
      this.adopt(dto);
    } catch {
      this.reloading = false;
      // Start over on a fresh connection; the retry refetches through `join` → `reload` again.
      this.socket?.close();
    }
  }
}
