import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet, useRouterState } from "@tanstack/react-router";
import { errorMessage } from "../api/client";
import { currentUser, setupStatus } from "../api/queries";
import { Button } from "../ui/button";
import { Toaster } from "../ui/toast";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";

/** Signed-in area: sends people to setup / login / password change / two-factor setup first, then shows the shell. */
export function AppLayout() {
  const setup = useQuery(setupStatus);
  const me = useQuery(currentUser);
  const here = useRouterState({ select: (state) => state.location.href });
  // While a redirect is under way the location can already be an auth page; never use one as the return address.
  const onAuthPage = /^\/(login|setup|change-password|set-up-two-factor)\b/.test(here);
  const returnTo = here === "/" || onAuthPage ? undefined : here;
  if (setup.isPending || me.isPending) return <p className="p-6 text-muted">Loading…</p>;
  if (setup.error || me.error) {
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
  if (setup.data.needsSetup) return <Navigate to="/setup" />;
  // Already heading to an auth page: navigating again would drop the return address.
  if (!me.data) return onAuthPage ? null : <Navigate to="/login" search={returnTo ? { redirect: returnTo } : {}} />;
  if (me.data.mustChangePassword) return <Navigate to="/change-password" />;
  if (me.data.mustSetUpTwoFactor) return <Navigate to="/set-up-two-factor" />;
  return (
    <div className="flex h-full">
      <Sidebar user={me.data} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar user={me.data} />
        <main className="min-h-0 flex-1 overflow-auto">
          <Outlet />
        </main>
        <Toaster />
      </div>
    </div>
  );
}
