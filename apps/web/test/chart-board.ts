import type { Command, Link } from "@ganttlines/engine";
import type { ProjectStateDto } from "@ganttlines/protocol";
import { waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";
import { CALENDAR, FakeWebSocket, PROJECT_ID, projectState } from "./board-fixtures";
import { ADMIN, project, renderApp, screen, signedIn } from "./utils";

export const sentCommands = (): Command[] =>
  FakeWebSocket.last.sent.flatMap((message) => ((message as { type: string }).type === "command" ? [(message as { command: Command }).command] : []));

/** A board opened and joined, with `rows` on it. */
export async function board(rows: ProjectStateDto["rows"], user = ADMIN, links: Link[] = []) {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const api = signedIn(user, [project(PROJECT_ID, "Launch")]);
  api.on(`GET /api/projects/${PROJECT_ID}/state`, () => ({ body: projectState(rows, 5, links) }));
  api.on("GET /api/calendar", () => ({ body: CALENDAR }));
  api.on("GET /api/resources", () => ({ body: { resources: [] } }));
  api.on(`GET /api/projects/${PROJECT_ID}/highlights`, () => ({ body: { highlights: [] } }));
  api.on(`GET /api/projects/${PROJECT_ID}/baselines`, () => ({ body: { baselines: [] } }));
  const rendered = renderApp(`/p/${PROJECT_ID}`);
  await screen.findByRole("treegrid", { name: "Tasks" });
  await waitFor(() => expect(FakeWebSocket.last.sent).toHaveLength(1));
  FakeWebSocket.last.deliver({ type: "joined", projectId: PROJECT_ID, version: 5, instanceVersion: 1, viewers: [] });
  return rendered;
}
