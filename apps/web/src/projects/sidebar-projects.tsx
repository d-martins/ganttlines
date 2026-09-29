import type { ProjectDto, UserDto } from "@ganttlines/protocol";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, MoreHorizontal, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { errorMessage } from "../api/client";
import { projectList, useCreateProject, useUpdateProject } from "../api/queries";
import { IconButton } from "../ui/button";
import { ErrorText } from "../ui/field";
import { Menu, MenuItem } from "../ui/menu";

const canManage = (user: UserDto) => user.role === "editor" || user.role === "admin";

/** The "Projects" section of the sidebar: open, create, rename and (un)archive projects. */
export function SidebarProjects({ user }: { user: UserDto }) {
  const active = useQuery(projectList(false));
  const all = useQuery(projectList(true));
  const create = useCreateProject();
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const archived = (all.data ?? []).filter((project) => project.archived);

  return (
    <section aria-labelledby="sidebar-projects" className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between px-2 pb-1">
        <h2 id="sidebar-projects" className="text-xs font-semibold uppercase tracking-wide text-muted">
          Projects
        </h2>
        {canManage(user) ? (
          <IconButton label="New project" onClick={() => setCreating(true)}>
            <Plus size={16} />
          </IconButton>
        ) : null}
      </div>
      {creating ? (
        <NameInput
          label="New project name"
          initial=""
          pending={create.isPending}
          onCancel={() => setCreating(false)}
          onSave={(name) => create.mutate({ name }, { onSuccess: () => setCreating(false) })}
        />
      ) : null}
      <ErrorText>{create.error ? errorMessage(create.error) : null}</ErrorText>
      {active.isError ? <ErrorText>{errorMessage(active.error)}</ErrorText> : null}
      {active.data?.map((project) => <ProjectItem key={project.id} project={project} manage={canManage(user)} />)}
      {active.data?.length === 0 && !creating ? <p className="px-2 text-sm text-muted">No projects yet.</p> : null}
      {archived.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={showArchived}
            onClick={() => setShowArchived(!showArchived)}
            className="mt-2 flex items-center gap-1 px-2 text-xs font-medium text-muted hover:text-text"
          >
            {showArchived ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Archived ({archived.length})
          </button>
          {showArchived ? archived.map((project) => <ProjectItem key={project.id} project={project} manage={canManage(user)} />) : null}
        </>
      ) : null}
    </section>
  );
}

function ProjectItem({ project, manage }: { project: ProjectDto; manage: boolean }) {
  const update = useUpdateProject();
  const [renaming, setRenaming] = useState(false);
  if (renaming) {
    return (
      <>
        <NameInput
          label="Project name"
          initial={project.name}
          pending={update.isPending}
          onCancel={() => setRenaming(false)}
          onSave={(name) => update.mutate({ id: project.id, name }, { onSuccess: () => setRenaming(false) })}
        />
        <ErrorText>{update.error ? errorMessage(update.error) : null}</ErrorText>
      </>
    );
  }
  return (
    <div className="group flex items-center rounded-md hover:bg-surface-2">
      <Link
        to="/p/$projectId"
        params={{ projectId: project.id }}
        className={`flex-1 truncate rounded-md px-2 py-1.5 text-sm ${project.archived ? "text-muted" : ""}`}
        activeProps={{ className: "bg-accent-soft font-semibold text-text" }}
      >
        {project.name}
      </Link>
      {manage ? (
        <Menu
          trigger={
            <button type="button" aria-label={`Actions for ${project.name}`} className="mr-1 rounded p-1 text-muted opacity-0 hover:text-text focus:opacity-100 group-hover:opacity-100">
              <MoreHorizontal size={16} />
            </button>
          }
        >
          <MenuItem onSelect={() => setRenaming(true)}>
            <span className="flex items-center gap-2">
              <Pencil size={14} /> Rename
            </span>
          </MenuItem>
          <MenuItem onSelect={() => update.mutate({ id: project.id, archived: !project.archived })}>
            <span className="flex items-center gap-2">
              {project.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />} {project.archived ? "Unarchive" : "Archive"}
            </span>
          </MenuItem>
        </Menu>
      ) : null}
    </div>
  );
}

/**
 * Inline name editor: Enter or clicking away saves (if changed and not empty), Escape cancels.
 * Ignores further saves while one is in flight.
 */
function NameInput({
  label,
  initial,
  pending,
  onSave,
  onCancel,
}: {
  label: string;
  initial: string;
  pending: boolean;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const commit = () => {
    if (pending) return;
    const name = value.trim();
    if (!name || name === initial) onCancel();
    else onSave(name);
  };
  return (
    <input
      aria-label={label}
      autoFocus
      value={value}
      disabled={pending}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
        if (event.key === "Enter") commit();
      }}
      className="mx-1 rounded-md border border-accent bg-bg px-2 py-1 text-sm"
    />
  );
}
