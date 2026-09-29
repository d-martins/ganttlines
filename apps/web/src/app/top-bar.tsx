import type { UserDto } from "@ganttlines/protocol";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { errorMessage } from "../api/client";
import { projectList, useLogout } from "../api/queries";
import { useTheme, type ThemePreference } from "../theme";
import { Avatar } from "../ui/avatar";
import { Menu, MenuItem, MenuLabel, MenuRadio, MenuSeparator } from "../ui/menu";

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Top bar: current page title and the account menu (theme, sign out). Board tools join it in plan 3b. */
export function TopBar({ user }: { user: UserDto }) {
  const navigate = useNavigate();
  const logout = useLogout();
  const { preference, setPreference } = useTheme();
  const params = useParams({ strict: false }) as { projectId?: string };
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const projects = useQuery(projectList(true));
  const title = params.projectId
    ? (projects.data?.find((project) => project.id === params.projectId)?.name ?? "")
    : pathname.startsWith("/team")
      ? "Team & calendar"
      : pathname.startsWith("/settings")
        ? "Settings"
        : "";

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
      <h1 className="truncate text-sm font-semibold">{title}</h1>
      <div className="ml-auto">
        <Menu
          trigger={
            <button type="button" aria-label="Account menu" className="rounded-full">
              <Avatar name={user.name} color="#5b6474" size={28} />
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
