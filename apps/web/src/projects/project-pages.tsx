import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@tanstack/react-router";
import { currentUser, projectList } from "../api/queries";
import { isString, readPref } from "../storage";

/** "/": open the last project used in this browser, else the first one. */
export function HomeRedirect() {
  const me = useQuery(currentUser);
  const projects = useQuery(projectList(false));
  if (projects.isPending || !me.data) return <p className="p-6 text-muted">Loading…</p>;
  const list = projects.data ?? [];
  const last = readPref(lastProjectKey(me.data.id), "", isString);
  const target = list.find((project) => project.id === last) ?? list[0];
  if (target) return <Navigate to="/p/$projectId" params={{ projectId: target.id }} />;
  const canCreate = me.data.role === "editor" || me.data.role === "admin";
  return (
    <div className="p-8 text-muted">
      <p className="text-text">No projects yet.</p>
      <p>
        {canCreate
          ? "Create one with the + next to “Projects” in the sidebar."
          : "When someone shares a project with you, open the link they sent — or ask an editor to create one."}
      </p>
    </div>
  );
}

/** The last opened project is remembered per person, so a shared browser never mixes people up. */
export const lastProjectKey = (userId: string) => `lastProject:${userId}`;
