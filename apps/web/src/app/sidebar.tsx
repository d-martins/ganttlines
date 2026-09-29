import type { UserDto } from "@ganttlines/protocol";
import { Link } from "@tanstack/react-router";
import { ChevronsLeft, ChevronsRight, FolderKanban, Settings, Users } from "lucide-react";
import { SidebarProjects } from "../projects/sidebar-projects";
import { IconButton } from "../ui/button";
import { useSidebar } from "./sidebar-store";

/** Left sidebar: projects, Team and Settings. Collapses to an icon rail via the bottom-right button. */
export function Sidebar({ user }: { user: UserDto }) {
  const { collapsed, toggle } = useSidebar();
  const toggleButton = (
    <IconButton label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={toggle}>
      {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
    </IconButton>
  );

  if (collapsed) {
    return (
      <nav aria-label="Main" className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface py-2">
        <IconButton label="Projects" onClick={toggle}>
          <FolderKanban size={18} />
        </IconButton>
        {user.role !== "guest" ? <RailLink to="/team" label="Team & calendar" icon={<Users size={18} />} /> : null}
        <RailLink to="/settings" label="Settings" icon={<Settings size={18} />} />
        <div className="mt-auto">{toggleButton}</div>
      </nav>
    );
  }

  return (
    <nav aria-label="Main" className="flex w-60 shrink-0 flex-col border-r border-border bg-surface">
      <div className="px-3 py-3 text-sm font-semibold">GanttLines</div>
      <div className="flex-1 overflow-y-auto px-1">
        <SidebarProjects user={user} />
        <section aria-labelledby="sidebar-workspace" className="mt-4 flex flex-col gap-0.5">
          <h2 id="sidebar-workspace" className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted">
            Workspace
          </h2>
          {/* Guests only reach boards through share links; the team calendar is for members. */}
          {user.role !== "guest" ? (
            <SideLink to="/team" icon={<Users size={16} />}>
              Team &amp; calendar
            </SideLink>
          ) : null}
          <SideLink to="/settings" icon={<Settings size={16} />}>
            Settings
          </SideLink>
        </section>
      </div>
      <div className="flex justify-end p-2">{toggleButton}</div>
    </nav>
  );
}

function SideLink({ to, icon, children }: { to: "/team" | "/settings"; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <Link to={to} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-2" activeProps={{ className: "bg-accent-soft font-semibold" }}>
      {icon}
      {children}
    </Link>
  );
}

function RailLink({ to, label, icon }: { to: "/team" | "/settings"; label: string; icon: React.ReactNode }) {
  return (
    <Link to={to} aria-label={label} title={label} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text">
      {icon}
    </Link>
  );
}
