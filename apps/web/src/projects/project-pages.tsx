import { useQuery } from "@tanstack/react-query";
import { Navigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { currentUser, projectList } from "../api/queries";
import { isString, readPref, writePref } from "../storage";

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
const lastProjectKey = (userId: string) => `lastProject:${userId}`;

/** The board (task list + chart) arrives in plan 3b; for now this confirms the project and remembers it. */
export function BoardPage() {
  const { projectId } = useParams({ from: "/app/p/$projectId" });
  const me = useQuery(currentUser);
  const projects = useQuery(projectList(true));
  const project = projects.data?.find((candidate) => candidate.id === projectId);
  const userId = me.data?.id;
  useEffect(() => {
    if (userId && project) writePref(lastProjectKey(userId), projectId);
  }, [userId, project, projectId]);
  if (projects.isPending) return <p className="p-6 text-muted">Loading…</p>;
  if (!project) return <p className="p-6 text-muted">This project doesn't exist or you don't have access to it.</p>;
  return (
    <div className="p-8">
      <p className="text-muted">
        The board for <strong className="text-text">{project.name}</strong> arrives in the next step.
      </p>
    </div>
  );
}
