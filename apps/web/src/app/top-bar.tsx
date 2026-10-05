import type { UserDto } from "@ganttlines/protocol";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { errorMessage } from "../api/client";
import { useActiveBoard } from "../board/active-board";
import { BoardTools } from "../board/board-tools";
import { projectList, resourceList, useLogout } from "../api/queries";
import { useTheme, type ThemePreference } from "../theme";
import { Avatar } from "../ui/avatar";
import { Menu, MenuItem, MenuLabel, MenuRadio, MenuSeparator } from "../ui/menu";
import { ThemeToggle } from "./theme-toggle";

/** Stand-in store while no board is open (hooks can't be skipped). */
const EMPTY = createStore<{ project?: { name: string } } | null>(() => null);

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Top bar: current page title, the board's tools (on a board) and the account menu (theme, sign out). */
export function TopBar({ user }: { user: UserDto }) {
  const navigate = useNavigate();
  const logout = useLogout();
  const { preference, setPreference } = useTheme();
  const params = useParams({ strict: false }) as { projectId?: string };
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const projects = useQuery(projectList(true));
  // The person's team-member color (guests can't read the team).
  const resources = useQuery({ ...resourceList, enabled: user.role !== "guest" });
  const color = resources.data?.find((resource) => resource.userId === user.id)?.avatarColor ?? "#5b6474";
  const board = useActiveBoard((state) => state.sync);
  // While switching projects the previous board is still registered: only trust the one shown.
  const shownBoard = board && board.projectId === params.projectId ? board : null;
  const boardName = useStore(shownBoard?.store ?? EMPTY, (state) => state?.project?.name);
  const title = params.projectId
    ? (boardName ?? projects.data?.find((project) => project.id === params.projectId)?.name ?? "")
    : pathname.startsWith("/team")
      ? "Team & calendar"
      : pathname.startsWith("/settings")
        ? "Settings"
        : "";

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
      <h1 className="max-w-64 min-w-12 shrink-0 truncate text-sm font-semibold">{title}</h1>
      {shownBoard ? <BoardTools sync={shownBoard} /> : null}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <ThemeToggle />
        <Menu
          trigger={
            <button type="button" aria-label="Account menu" className="rounded-full">
              <Avatar name={user.name} color={color} size={28} />
            </button>
          }
        >
          <MenuLabel>
            {user.name} · {user.email}
          </MenuLabel>
          <MenuSeparator />
          <MenuLabel>Theme</MenuLabel>
          <MenuRadio value={preference} options={THEMES} onChange={setPreference} />
          <MenuSeparator />
          <MenuItem onSelect={() => logout.mutate(undefined, { onSuccess: () => navigate({ to: "/login" }) })}>Sign out</MenuItem>
        </Menu>
      </div>
      {logout.isError ? (
        <p role="alert" className="text-xs text-danger">
          Couldn't sign out: {errorMessage(logout.error)}
        </p>
      ) : null}
    </header>
  );
}
