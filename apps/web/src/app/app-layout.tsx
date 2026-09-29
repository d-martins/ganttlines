import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet } from "@tanstack/react-router";
import { errorMessage } from "../api/client";
import { currentUser, setupStatus } from "../api/queries";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";

/** Signed-in area: sends people to setup / login / password change first, then shows the shell. */
export function AppLayout() {
  const setup = useQuery(setupStatus);
  const me = useQuery(currentUser);
  if (setup.isPending || me.isPending) return <p className="p-6 text-muted">Loading…</p>;
  if (setup.error || me.error) return <p className="p-6 text-danger">{errorMessage(setup.error ?? me.error)}</p>;
  if (setup.data.needsSetup) return <Navigate to="/setup" />;
  if (!me.data) return <Navigate to="/login" />;
  if (me.data.mustChangePassword) return <Navigate to="/change-password" />;
  return (
    <div className="flex h-full">
      <Sidebar user={me.data} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar user={me.data} />
        <main className="min-h-0 flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
