import type { CalendarDto } from "@ganttlines/protocol";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { ApiError, errorMessage } from "../api/client";
import { baselineSnapshot, calendar, currentUser, highlightList, keys, loadProjectState, resourceList } from "../api/queries";
import { lastProjectKey } from "../projects/project-pages";
import { writePref } from "../storage";
import { BoardSync, type BoardEvent, type SocketLike } from "../sync/board-sync";
import { Button } from "../ui/button";
import { useActiveBoard } from "./active-board";
import { Board } from "./board";

const webSocketUrl = () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

/** A broadcast list is the newest truth: drop any refetch still in flight so it can't overwrite it. */
function replaceList(client: QueryClient, queryKey: readonly unknown[], list: unknown[]): void {
  void client.cancelQueries({ queryKey, exact: true });
  client.setQueryData(queryKey, list);
}

/** Keeps the REST caches in step with what the WebSocket reports. */
function applyEvent(client: QueryClient, projectId: string, event: BoardEvent): void {
  switch (event.type) {
    case "joined": {
      // Unversioned lists may have changed while disconnected; the calendar only if its version moved.
      void client.invalidateQueries({ queryKey: keys.project(projectId) });
      if (client.getQueryData<CalendarDto>(keys.calendar)?.instanceVersion !== event.instanceVersion) {
        void client.invalidateQueries({ queryKey: keys.calendar });
        void client.invalidateQueries({ queryKey: keys.resources });
      }
      return;
    }
    case "instance":
      void client.invalidateQueries({ queryKey: keys.calendar });
      void client.invalidateQueries({ queryKey: keys.resources });
      return;
    case "highlights":
      return replaceList(client, keys.highlights(projectId), event.highlights);
    case "baselines":
      return replaceList(client, keys.baselines(projectId), event.baselines);
    case "comment":
      return; // comments arrive with the details panel (plan 3d)
  }
}

/** One live board: created per project, started on mount, stopped on unmount. */
function useBoardSync(projectId: string): BoardSync | null {
  const client = useQueryClient();
  const [sync, setSync] = useState<BoardSync | null>(null);
  useEffect(() => {
    const next = new BoardSync({
      projectId,
      // Through the query cache, so a lost session is noticed like any other request.
      loadState: () => client.fetchQuery({ queryKey: [...keys.project(projectId), "state"], queryFn: () => loadProjectState(projectId), staleTime: 0, gcTime: 0 }),
      openSocket: () => new WebSocket(webSocketUrl()) as unknown as SocketLike,
      onEvent: (event) => applyEvent(client, projectId, event),
      isFatal: (error) => error instanceof ApiError && error.status >= 400 && error.status < 500,
    });
    setSync(next);
    useActiveBoard.setState({ sync: next });
    void next.start();
    return () => {
      next.stop();
      if (useActiveBoard.getState().sync === next) useActiveBoard.setState({ sync: null });
    };
  }, [client, projectId]);
  return sync?.projectId === projectId ? sync : null;
}

export function BoardPage() {
  const { projectId } = useParams({ from: "/app/p/$projectId" });
  const sync = useBoardSync(projectId);
  if (!sync) return <p className="p-6 text-muted">Loading…</p>;
  return <LiveBoard key={projectId} sync={sync} />;
}

function LiveBoard({ sync }: { sync: BoardSync }) {
  const projectId = sync.projectId;
  const client = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ from: "/app/p/$projectId" });
  const state = useStore(sync.store);
  const me = useQuery(currentUser);
  const calendarQuery = useQuery(calendar);
  const resources = useQuery(resourceList);
  const highlights = useQuery(highlightList(projectId));
  const snapshot = useQuery({ ...baselineSnapshot(projectId, search.baseline ?? ""), enabled: Boolean(search.baseline) });

  const baselineMode = search.baseline ? (search.compare ?? "overlay") : null;
  const tasks = snapshot.data?.tasks;
  const baseline = useMemo(() => (baselineMode && tasks ? { mode: baselineMode, tasks } : null), [baselineMode, tasks]);

  const userId = me.data?.id;
  const loaded = state.project !== null;
  useEffect(() => {
    if (userId && loaded) writePref(lastProjectKey(userId), projectId);
  }, [userId, loaded, projectId]);
  // The server ended the session: re-check who is signed in (the layout then sends people to sign in).
  useEffect(() => {
    if (state.endReason === "signed_out") void client.invalidateQueries({ queryKey: keys.me });
  }, [state.endReason, client]);

  if (state.loadError) return <LoadError error={state.loadError} />;
  if (state.endReason === "flooding") {
    return (
      <div className="p-8">
        <p>The connection to the server was closed. Reload the page to continue.</p>
        <Button className="mt-3" onClick={() => location.reload()}>
          Reload
        </Button>
      </div>
    );
  }
  if (!state.project || calendarQuery.isPending || resources.isPending) return <p className="p-6 text-muted">Loading…</p>;
  if (calendarQuery.error || resources.error) return <p className="p-6 text-danger">{errorMessage(calendarQuery.error ?? resources.error)}</p>;

  return (
    <div className="flex h-full flex-col">
      {state.status === "reconnecting" ? (
        <p role="status" className="border-b border-border bg-surface-2 px-4 py-1.5 text-sm">
          Reconnecting… changes by others will appear once the connection is back.
        </p>
      ) : null}
      {state.joinError ? (
        <p role="alert" className="border-b border-border bg-surface-2 px-4 py-1.5 text-sm text-danger">
          {state.joinError}
        </p>
      ) : null}
      {state.project.archived ? (
        <p role="status" className="border-b border-border bg-surface-2 px-4 py-1.5 text-sm text-muted">
          This project is archived: it can be viewed but not changed.
        </p>
      ) : null}
      {baselineMode === "switch" && snapshot.data ? (
        <p role="status" className="flex items-center gap-3 border-b border-border bg-accent-soft px-4 py-1.5 text-sm">
          Viewing baseline <strong>{snapshot.data.baseline.name}</strong> (read-only).
          <button type="button" className="underline" onClick={() => void navigate({ to: ".", search: {} })}>
            Back to the live plan
          </button>
        </p>
      ) : null}
      {snapshot.error ? (
        <p role="alert" className="border-b border-border px-4 py-1.5 text-sm text-danger">
          Couldn't load the baseline: {errorMessage(snapshot.error)}
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        <Board state={state.confirmed} calendarDto={calendarQuery.data} resources={resources.data} highlights={highlights.data ?? []} baseline={baseline} />
      </div>
    </div>
  );
}

function LoadError({ error }: { error: unknown }) {
  const status = error instanceof ApiError ? error.status : 0;
  const text =
    status === 404
      ? "This project doesn't exist — it may have been deleted."
      : status === 403
        ? "You don't have access to this project."
        : `Couldn't open the project: ${errorMessage(error)}`;
  return (
    <div className="p-8">
      <p>{text}</p>
      <Link to="/" className="mt-2 inline-block text-accent underline">
        Go to your projects
      </Link>
    </div>
  );
}
