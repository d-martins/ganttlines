import { createRootRoute, createRoute, createRouter, Outlet, type RouterHistory } from "@tanstack/react-router";
import { AppLayout } from "./app/app-layout";
import { ErrorScreen } from "./app/error-screen";
import { ChangePasswordPage, LoginPage, SetupPage } from "./auth/auth-pages";
import { BoardPage, HomeRedirect } from "./projects/project-pages";
import { SettingsPage } from "./settings/settings-page";
import { TeamPage } from "./team/team-page";

const rootRoute = createRootRoute({ component: Outlet });
const setupRoute = createRoute({ getParentRoute: () => rootRoute, path: "/setup", component: SetupPage });
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
  // Where to return after signing in (only same-app paths are honoured).
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => (isAppPath(search["redirect"]) ? { redirect: search["redirect"] } : {}),
});
const changePasswordRoute = createRoute({ getParentRoute: () => rootRoute, path: "/change-password", component: ChangePasswordPage });
const appRoute = createRoute({ getParentRoute: () => rootRoute, id: "app", component: AppLayout });
const homeRoute = createRoute({ getParentRoute: () => appRoute, path: "/", component: HomeRedirect });
const boardRoute = createRoute({ getParentRoute: () => appRoute, path: "/p/$projectId", component: BoardPage });
const teamRoute = createRoute({ getParentRoute: () => appRoute, path: "/team", component: TeamPage });
const settingsRoute = createRoute({ getParentRoute: () => appRoute, path: "/settings", component: SettingsPage });

const routeTree = rootRoute.addChildren([
  setupRoute,
  loginRoute,
  changePasswordRoute,
  appRoute.addChildren([homeRoute, boardRoute, teamRoute, settingsRoute]),
]);

/** A path inside this app ("/p/…"), never another site ("//evil.example", "https://…"). */
export function isAppPath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\");
}

export function createAppRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    ...(history ? { history } : {}),
    defaultNotFoundComponent: () => <p className="p-6 text-muted">Page not found.</p>,
    defaultErrorComponent: ErrorScreen,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
