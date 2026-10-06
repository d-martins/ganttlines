import { ServerSource, type SocketLike, type WorkspaceSource } from "@ganttlines/client";
import { api, currentShareToken } from "./api/client";

/** In link mode the socket carries the link's token (the REST client sends it as a header). */
const webSocketUrl = (shareToken: string | null) =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws${shareToken ? `?share=${encodeURIComponent(shareToken)}` : ""}`;

const current: WorkspaceSource = new ServerSource({
  api,
  openLink: () => new WebSocket(webSocketUrl(currentShareToken())) as unknown as SocketLike,
});

/** Where the workspace lives: projects, boards, the team calendar, highlights and baselines. */
export const workspace = (): WorkspaceSource => current;
