import type { LocalSource } from "@ganttlines/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useState } from "react";
import { errorMessage } from "../api/client";
import { currentUser, keys, setupStatus } from "../api/queries";
import { Button } from "../ui/button";
import { Toaster } from "../ui/toast";
import { forgetWorkspaceCache, localOnly, serverSource, useWorkspace } from "../workspace";
import { LOCAL_PERSON, reopenLocalWorkspace, useStorageStatus } from "../workspace/local";
import { LocalWorkspaceProblem, OpenElsewhere, StorageBanner } from "../workspace/local-screens";
import { useTabLock } from "../workspace/tab-lock";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";
import { useActiveBoard } from "../board/active-board";

/**
 * This browser's workspace, read from storage each time this tab gets the lock (another tab may have
 * changed it in between).
 */
function useLocalSource(held: boolean, grant: number) {
  const [state, setState] = useState<{ source?: LocalSource; error?: unknown }>({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!held) return;
    let current = true;
    setState({});
    reopenLocalWorkspace().then(
      (source) => current && setState({ source }),
      (error: unknown) => current && setState({ error }),
    );
    return () => {
      current = false;
    };
  }, [held, grant, attempt]);
  return { ...state, retry: () => setAttempt((n) => n + 1) };
}

/**
 * The app shell. Signed in: the server's workspace (setup, login, password change and two-factor
 * setup come first). Not signed in: this browser's workspace in the local-only build, or on a server
 * that lets visitors work locally — otherwise the sign-in page.
 */
export function AppLayout() {
  const client = useQueryClient();
  const onlyLocal = localOnly();
  const setup = useQuery({ ...setupStatus, enabled: !onlyLocal });
  const me = useQuery(currentUser);
  const here = useRouterState({ select: (state) => state.location.href });
  // While a redirect is under way the location can already be an auth page; never use one as the return address.
  const onAuthPage = /^\/(login|setup|change-password|set-up-two-factor)\b/.test(here);
  const returnTo = here === "/" || onAuthPage ? undefined : here;
  const visitorsWorkLocally = setup.data?.localForVisitors === true;
  const wantLocal = onlyLocal || me.data?.id === LOCAL_PERSON.id || (me.data === null && visitorsWorkLocally);
  const lock = useTabLock(wantLocal);
  const local = useLocalSource(wantLocal && lock.state === "held", lock.grant);
  const wanted = wantLocal ? local.source : serverSource;
  const active = useWorkspace((state) => state.source);
  const storageFailed = useStorageStatus((state) => state.failed);

  // In this browser's workspace an edit is saved by this tab: closing it first would lose the edit.
  useEffect(() => {
    if (!wantLocal) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (useActiveBoard.getState().sync?.state.pending.some((entry) => entry.ackVersion === null)) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [wantLocal]);

  // Switch workspaces before anything below asks for data, and forget the other workspace's data.
  useLayoutEffect(() => {
    if (!wanted || active === wanted) return;
    useWorkspace.setState({ source: wanted });
    forgetWorkspaceCache(client);
    void client.invalidateQueries({ queryKey: keys.me });
  }, [wanted, active, client]);

  const loading = <p className="p-6 text-muted">Loading…</p>;
  if (onlyLocal ? me.isPending : setup.isPending || me.isPending) return loading;
  if (!onlyLocal && (setup.error || me.error)) {
    // Usually the server is unreachable (restarting, offline): offer a retry instead of a dead end.
    return (
      <div className="p-6">
        <p role="alert" className="text-danger">
          {errorMessage(setup.error ?? me.error)}
        </p>
        <Button className="mt-3" onClick={() => void Promise.all([setup.refetch(), me.refetch()])}>
          Try again
        </Button>
      </div>
    );
  }
  if (!onlyLocal && setup.data?.needsSetup) return <Navigate to="/setup" />;
  // Already heading to an auth page: navigating again would drop the return address.
  if (!wantLocal && !me.data) return onAuthPage ? null : <Navigate to="/login" search={returnTo ? { redirect: returnTo } : {}} />;
  if (wantLocal && lock.state === "elsewhere") return <OpenElsewhere onUseHere={() => void lock.take()} />;
  if (wantLocal && local.error) return <LocalWorkspaceProblem error={local.error} onRetry={local.retry} />;
  if (!wanted || active !== wanted || !me.data) return loading;
  if (me.data.mustChangePassword) return <Navigate to="/change-password" />;
  if (me.data.mustSetUpTwoFactor) return <Navigate to="/set-up-two-factor" />;
  return (
    <div className="flex h-full">
      <Sidebar user={me.data} />
      <div className="flex min-w-0 flex-1 flex-col">
        {wantLocal && storageFailed ? <StorageBanner /> : null}
        <TopBar user={me.data} signIn={wantLocal && visitorsWorkLocally} signOutTo={visitorsWorkLocally ? "/" : "/login"} />
        <main className="min-h-0 flex-1 overflow-auto">
          <Outlet />
        </main>
        <Toaster />
      </div>
    </div>
  );
}
