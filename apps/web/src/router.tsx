import { createRootRoute, createRoute, createRouter, Outlet, type RouterHistory } from "@tanstack/react-router";
import { AppLayout } from "./app/app-layout";
import { ErrorScreen } from "./app/error-screen";
import { ChangePasswordPage, ChoosePasswordPage, ForgotPasswordPage, LoginPage, SetupPage, SetUpTwoFactorPage } from "./auth/auth-pages";
import { BoardPage } from "./board/board-page";
import type { CompareMode } from "./board/model";
import { HomeRedirect } from "./projects/project-pages";
import { SettingsPage } from "./settings/settings-page";
import { SharePage } from "./share/share-page";
import { TeamPage } from "./team/team-page";

const rootRoute = createRootRoute({ component: Outlet });
const setupRoute = createRoute({ getParentRoute: () => rootRoute, path: "/setup", component: SetupPage });
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
  // Where to return after signing in (only same-app paths are honoured).
  validateSearch: (search: Record<string, unknown>): { redirect?: string; error?: string } => ({
    ...(isAppPath(search["redirect"]) ? { redirect: search["redirect"] } : {}),
    // why a single sign-on attempt came back here
    ...(typeof search["error"] === "string" ? { error: search["error"] } : {}),
  }),
});
const forgotPasswordRoute = createRoute({ getParentRoute: () => rootRoute, path: "/forgot-password", component: ForgotPasswordPage });
/** `?token=…` from an emailed invitation or reset link. */
const choosePasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset-password",
  component: ChoosePasswordPage,
  validateSearch: (search: Record<string, unknown>): { token?: string } => (typeof search["token"] === "string" ? { token: search["token"] } : {}),
});
const changePasswordRoute = createRoute({ getParentRoute: () => rootRoute, path: "/change-password", component: ChangePasswordPage });
const setUpTwoFactorRoute = createRoute({ getParentRoute: () => rootRoute, path: "/set-up-two-factor", component: SetUpTwoFactorPage });
const appRoute = createRoute({ getParentRoute: () => rootRoute, id: "app", component: AppLayout });
const homeRoute = createRoute({ getParentRoute: () => appRoute, path: "/", component: HomeRedirect });
/** `?baseline=<id>&compare=switch`: only well-formed values are kept. */
function validateBoardSearch(search: Record<string, unknown>): BoardSearch {
  const baseline = typeof search["baseline"] === "string" && /^[0-9a-f-]{36}$/i.test(search["baseline"]) ? search["baseline"] : undefined;
  if (!baseline) return {};
  return search["compare"] === "switch" ? { baseline, compare: "switch" } : { baseline };
}

/** Board URL state: the baseline being compared (`?baseline=<id>&compare=switch`, overlay by default). */
export interface BoardSearch {
  baseline?: string;
  compare?: CompareMode;
}
const boardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/p/$projectId",
  component: BoardPage,
  validateSearch: validateBoardSearch,
});
/** A board opened through a share link: outside the signed-in layout (no sidebar; may be anonymous). */
const shareRoute = createRoute({ getParentRoute: () => rootRoute, path: "/s/$token", component: SharePage, validateSearch: validateBoardSearch });
const teamRoute = createRoute({ getParentRoute: () => appRoute, path: "/team", component: TeamPage });
const settingsRoute = createRoute({ getParentRoute: () => appRoute, path: "/settings", component: SettingsPage });

const routeTree = rootRoute.addChildren([
  setupRoute,
  loginRoute,
  changePasswordRoute,
  setUpTwoFactorRoute,
  forgotPasswordRoute,
  choosePasswordRoute,
  shareRoute,
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
