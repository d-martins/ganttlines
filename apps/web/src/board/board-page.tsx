import { Calendar } from "@ganttlines/engine";
import type { CalendarDto } from "@ganttlines/protocol";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { BoardSearch } from "../router";
import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { ApiError, errorMessage } from "../api/client";
import { baselineSnapshot, calendar, currentUser, highlightList, keys, loadProjectState, resourceList, upsertComment } from "../api/queries";
import { lastProjectKey } from "../projects/project-pages";
import { writePref } from "../storage";
import { BoardSync, type BoardEvent, type SocketLike } from "../sync/board-sync";
import { Button } from "../ui/button";
import { toast } from "../ui/toast";
import { BoardContext, type BoardContextValue } from "./board-context";
import { replay } from "./pending";
import { resetSelection } from "./selection";
import { useActiveBoard } from "./active-board";
import { Board } from "./board";

/** In link mode the socket carries the link's token (the REST client sends it as a header). */
const webSocketUrl = (shareToken: string | null) =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws${shareToken ? `?share=${encodeURIComponent(shareToken)}` : ""}`;

/** The board opened through a share link: its token and whether the link lets people edit. */
export interface ShareAccess {
  token: string;
  collaboration: boolean;
}

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
      void client.invalidateQueries({ queryKey: keys.commentCounts(projectId) });
      return upsertComment(client, projectId, event.comment);
    case "rejected":
      return toast(`Change not saved: ${event.message}`, { tone: "error" });
    case "history":
      if (event.skipped > 0) toast(`Part of that change was left as is: the board changed since (${event.skipped} ${event.skipped === 1 ? "field" : "fields"}).`);
      return;
    case "historyFailed":
      return toast(event.message, { tone: "error" });
  }
}

/** One live board: created per project, started on mount, stopped on unmount. */
function useBoardSync(projectId: string, shareToken: string | null): BoardSync | null {
  const client = useQueryClient();
  const [sync, setSync] = useState<BoardSync | null>(null);
  useEffect(() => {
    const next = new BoardSync({
      projectId,
      // Through the query cache, so a lost session is noticed like any other request.
      loadState: () => client.fetchQuery({ queryKey: [...keys.project(projectId), "state"], queryFn: () => loadProjectState(projectId), staleTime: 0, gcTime: 0 }),
      openSocket: () => new WebSocket(webSocketUrl(shareToken)) as unknown as SocketLike,
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
  }, [client, projectId, shareToken]);
  return sync?.projectId === projectId ? sync : null;
}

export function BoardPage() {
  const { projectId } = useParams({ from: "/app/p/$projectId" });
  return <BoardScreen projectId={projectId} share={null} />;
}

/** A live board — signed in normally, or opened through a share link (`share`). */
export function BoardScreen({ projectId, share }: { projectId: string; share: ShareAccess | null }) {
  const sync = useBoardSync(projectId, share?.token ?? null);
  if (!sync) return <p className="p-6 text-muted">Loading…</p>;
  return <LiveBoard key={projectId} sync={sync} share={share} />;
}

function LiveBoard({ sync, share }: { sync: BoardSync; share: ShareAccess | null }) {
  const projectId = sync.projectId;
  const client = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as BoardSearch;
  const state = useStore(sync.store);
  const me = useQuery(currentUser);
  const calendarQuery = useQuery(calendar);
  const resources = useQuery(resourceList);
  const highlights = useQuery(highlightList(projectId));
  const snapshot = useQuery({ ...baselineSnapshot(projectId, search.baseline ?? ""), enabled: Boolean(search.baseline) });

  const baselineMode = search.baseline ? (search.compare ?? "overlay") : null;
  const tasks = snapshot.data?.tasks;
  const baseline = useMemo(() => (baselineMode && tasks ? { mode: baselineMode, tasks } : null), [baselineMode, tasks]);

  const calendarDto = calendarQuery.data;
  const engineCalendar = useMemo(() => (calendarDto ? new Calendar(calendarDto) : null), [calendarDto]);
  const rendered = useMemo(
    () => (engineCalendar ? replay(state.confirmed, state.pending, engineCalendar) : state.confirmed),
    [state.confirmed, state.pending, engineCalendar],
  );
  // Rights (mirroring the server): members act as themselves, even through a link; a collaborative
  // link also lets guests, viewers and anonymous visitors edit and comment. Only signed-in editors
  // and admins change the team calendar, add team members, share, and save baselines.
  const role = me.data?.role;
  const member = me.data !== null && me.data !== undefined && role !== "guest" && !me.data.mustChangePassword;
  const editorRole = member && (role === "editor" || role === "admin");
  const mayEdit = editorRole || share?.collaboration === true;
  const canEdit = mayEdit && state.status === "live" && state.project?.archived === false && baselineMode !== "switch";
  const resourceData = resources.data;
  const context = useMemo<BoardContextValue | null>(
    () =>
      engineCalendar && resourceData
        ? {
            sync,
            calendar: engineCalendar,
            state: rendered,
            resources: resourceData,
            resourceMap: new Map(resourceData.map((resource) => [resource.id, resource])),
            canEdit,
            canCreateResources: editorRole,
            canComment: member || share?.collaboration === true,
            canEditCalendar: editorRole,
          }
        : null,
    [sync, engineCalendar, rendered, resourceData, canEdit, editorRole, member, share],
  );
  const canManage = editorRole && !share;
  useEffect(() => {
    useActiveBoard.setState({ canEdit, canManage });
  }, [canEdit, canManage]);
  useEffect(resetSelection, [projectId]);
  // Every change to the board adds history: refresh the history lists on screen (details panel).
  useEffect(() => {
    void client.invalidateQueries({ queryKey: keys.allActivity(projectId) });
  }, [client, projectId, state.version]);
  // Undo / redo from the keyboard, unless typing somewhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z" || !canEdit) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      event.preventDefault();
      sync.requestHistory(event.shiftKey ? "redo" : "undo");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sync, canEdit]);

  const userId = me.data?.id;
  const loaded = state.project !== null;
  useEffect(() => {
    if (userId && loaded && !share) writePref(lastProjectKey(userId), projectId);
  }, [userId, loaded, projectId, share]);
  // The server ended the session (or turned the link off): re-check who is signed in and, in link
  // mode, what the link still allows — the screens above then show sign-in / "link turned off".
  const shareToken = share?.token;
  useEffect(() => {
    if (state.endReason !== "signed_out") return;
    void client.invalidateQueries({ queryKey: keys.me });
    if (shareToken) void client.invalidateQueries({ queryKey: keys.shareInfo(shareToken) });
  }, [state.endReason, client, shareToken]);

  if (state.loadError) return <LoadError error={state.loadError} viaLink={share !== null} />;
  if (state.endReason === "deleted") {
    return (
      <div className="p-8">
        <p>This project was deleted.</p>
        {share ? null : (
          <Link to="/" className="mt-2 inline-block text-accent underline">
            Go to your projects
          </Link>
        )}
      </div>
    );
  }
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
  if (!state.project || !context || calendarQuery.isPending || resources.isPending) return <p className="p-6 text-muted">Loading…</p>;
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
        <BoardContext.Provider value={context}>
          <Board state={rendered} calendar={context.calendar} calendarDto={calendarQuery.data!} resources={context.resources} highlights={highlights.data ?? []} baseline={baseline} />
        </BoardContext.Provider>
      </div>
    </div>
  );
}

function LoadError({ error, viaLink }: { error: unknown; viaLink: boolean }) {
  const status = error instanceof ApiError ? error.status : 0;
  const text =
    status === 410
      ? "This share link was turned off."
      : status === 404
        ? viaLink
          ? "This link doesn't open anything any more — the project may have been deleted."
          : "This project doesn't exist — it may have been deleted."
        : status === 403
          ? "You don't have access to this project."
          : `Couldn't open the project: ${errorMessage(error)}`;
  return (
    <div className="p-8">
      <p>{text}</p>
      {viaLink ? null : (
        <Link to="/" className="mt-2 inline-block text-accent underline">
          Go to your projects
        </Link>
      )}
    </div>
  );
}
