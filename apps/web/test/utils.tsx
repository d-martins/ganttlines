import type { ProjectDto, UserDto } from "@ganttlines/protocol";
import * as Tooltip from "@radix-ui/react-tooltip";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { createQueryClient } from "../src/api/query-client";
import { createAppRouter } from "../src/router";

export type Handler = (body: unknown, url: URL) => { status?: number; body?: unknown } | undefined;

export interface FakeApi {
  /** every request made, as "METHOD /path" with its parsed body and headers */
  calls: { key: string; body: unknown; headers: Record<string, string> }[];
  on(key: string, handler: Handler): void;
}

/** Replaces fetch with a tiny router keyed by "METHOD /path". Unknown routes answer 404. */
export function fakeApi(handlers: Record<string, Handler> = {}): FakeApi {
  const routes = new Map(Object.entries(handlers));
  const calls: FakeApi["calls"] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://localhost");
    const key = `${init.method ?? "GET"} ${url.pathname}`;
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ key, body, headers: (init.headers ?? {}) as Record<string, string> });
    const reply = routes.get(key)?.(body, url) ?? { status: 404, body: { error: "not_found", message: `No handler for ${key}` } };
    const status = reply.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(reply.body ?? {}), { status, headers: { "content-type": "application/json" } });
  });
  return { calls, on: (key, handler) => routes.set(key, handler) };
}

export const ADMIN: UserDto = { id: "u-admin", email: "admin@example.com", name: "Ada Admin", role: "admin", mustChangePassword: false };
export const GUEST: UserDto = { id: "u-guest", email: "client@example.com", name: "Client", role: "guest", mustChangePassword: false };
export const VIEWER: UserDto = { id: "u-viewer", email: "vi@example.com", name: "Vi Viewer", role: "viewer", mustChangePassword: false };

export function project(id: string, name: string, archived = false): ProjectDto {
  return { id, name, version: 0, archived };
}

/** The API of a set-up instance where `user` is signed in. */
export function signedIn(user: UserDto, projects: ProjectDto[] = []): FakeApi {
  return fakeApi({
    "GET /api/setup": () => ({ body: { needsSetup: false } }),
    "GET /api/auth/me": () => ({ body: { user } }),
    "GET /api/projects": (_body, url) => ({ body: { projects: url.searchParams.get("archived") ? projects : projects.filter((p) => !p.archived) } }),
  });
}

/** Renders the whole app at `path` with a fresh query cache. */
export function renderApp(path: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const client = createQueryClient({ retry: false });
  const { unmount } = render(
    <QueryClientProvider client={client}>
      <Tooltip.Provider>
        <RouterProvider router={router} />
      </Tooltip.Provider>
    </QueryClientProvider>,
  );
  return { router, user: userEvent.setup(), unmount };
}

export { screen };
