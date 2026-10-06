import { ServerSource, type SocketLike, type WorkspaceCapabilities, type WorkspaceSource } from "@ganttlines/client";
import type { QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { api, currentShareToken } from "./api/client";

/** In link mode the socket carries the link's token (the REST client sends it as a header). */
const webSocketUrl = (shareToken: string | null) =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws${shareToken ? `?share=${encodeURIComponent(shareToken)}` : ""}`;

/** The server's workspace (signed in, or through a share link). */
export const serverSource: WorkspaceSource = new ServerSource({
  api,
  openLink: () => new WebSocket(webSocketUrl(currentShareToken())) as unknown as SocketLike,
});

/** Which workspace the app shows: the server's, or this browser's (local mode). */
export const useWorkspace = create<{ source: WorkspaceSource }>(() => ({ source: serverSource }));

/** Where the workspace lives right now: projects, boards, the team calendar, highlights and baselines. */
export const workspace = (): WorkspaceSource => useWorkspace.getState().source;

/** What the current workspace can do; the UI leaves out the rest. */
export const useCapabilities = (): WorkspaceCapabilities => useWorkspace((state) => state.source.capabilities);

/** The local-only build: no server at all. */
export const localOnly = (): boolean => import.meta.env.VITE_WORKSPACE === "local";

/**
 * After switching workspaces (or replacing this one) nothing cached from before may show: the data
 * is dropped and what's on screen is fetched again (setup and "who am I" are refreshed separately).
 */
export function forgetWorkspaceCache(client: QueryClient): void {
  void client.resetQueries({ predicate: (query) => query.queryKey[0] !== "setup" && query.queryKey[0] !== "me" });
}
