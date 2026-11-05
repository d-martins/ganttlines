import { createRootRoute, createRoute, createRouter, Outlet, redirect, type RouterHistory } from "@tanstack/react-router";
import { AppLayout } from "./app/app-layout";
import { ErrorScreen } from "./app/error-screen";
import { ChangePasswordPage, ChoosePasswordPage, ForgotPasswordPage, LoginPage, SetupPage, SetUpTwoFactorPage } from "./auth/auth-pages";
import { ConnectPage } from "./auth/connect-page";
import { BoardPage } from "./board/board-page";
import type { CompareMode } from "./board/model";
import { HomeRedirect } from "./projects/project-pages";
import { SettingsPage } from "./settings/settings-page";
import { SharePage } from "./share/share-page";
import { TeamPage } from "./team/team-page";
import { leaveTo } from "./app/leave";
import { localOnly, signInElsewhere } from "./workspace";

const rootRoute = createRootRoute({ component: Outlet });
/** Pages about accounts and servers: the local-only build has neither, so they lead home. */
const needsServer = {
  beforeLoad: () => {
    if (localOnly()) throw redirect({ to: "/" });
  },
};
const setupRoute = createRoute({ ...needsServer, getParentRoute: () => rootRoute, path: "/setup", component: SetupPage });
const loginRoute = createRoute({
  // The local-only build may name a sign-in elsewhere; otherwise it has none.
  beforeLoad: () => {
    if (!localOnly()) return;
    const elsewhere = signInElsewhere();
    if (elsewhere) leaveTo(elsewhere);
    throw redirect({ to: "/" });
  },
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
const forgotPasswordRoute = createRoute({ ...needsServer, getParentRoute: () => rootRoute, path: "/forgot-password", component: ForgotPasswordPage });
/** `?token=…` from an emailed invitation or reset link. */
const choosePasswordRoute = createRoute({ ...needsServer,
  getParentRoute: () => rootRoute,
  path: "/reset-password",
  component: ChoosePasswordPage,
  validateSearch: (search: Record<string, unknown>): { token?: string } => (typeof search["token"] === "string" ? { token: search["token"] } : {}),
});
const changePasswordRoute = createRoute({ ...needsServer, getParentRoute: () => rootRoute, path: "/change-password", component: ChangePasswordPage });
/** An AI app's "Allow access?" step (`?request=…` signed by the server, or `?error=…`). */
const connectRoute = createRoute({ ...needsServer,
  getParentRoute: () => rootRoute,
  path: "/connect",
  component: ConnectPage,
  validateSearch: (search: Record<string, unknown>): { request?: string; error?: string } => ({
    ...(typeof search["request"] === "string" ? { request: search["request"] } : {}),
    ...(typeof search["error"] === "string" ? { error: search["error"] } : {}),
  }),
});
const setUpTwoFactorRoute = createRoute({ ...needsServer, getParentRoute: () => rootRoute, path: "/set-up-two-factor", component: SetUpTwoFactorPage });
const appRoute = createRoute({ getParentRoute: () => rootRoute, id: "app", component: AppLayout });
const homeRoute = createRoute({ getParentRoute: () => appRoute, path: "/", component: HomeRedirect });
/**
 * `?baseline=<id>&compare=switch` and the filters `q`, `people`, `tags`, `sections`, `milestones`: only well-formed
 * values are kept. Lists are JSON arrays in the address, so any character in a tag survives.
 */
export function validateBoardSearch(search: Record<string, unknown>): BoardSearch {
  const result: BoardSearch = {};
  const baseline = typeof search["baseline"] === "string" && /^[0-9a-f-]{36}$/i.test(search["baseline"]) ? search["baseline"] : undefined;
  if (baseline) {
    result.baseline = baseline;
    if (search["compare"] === "switch") result.compare = "switch";
  }
  // A typed `?q=2026` (or `?tags=2026`) arrives as a number.
  const text = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? String(value) : value);
  const q = text(search["q"]);
  if (typeof q === "string" && q.trim() !== "") result.q = q;
  for (const key of ["people", "tags", "sections", "milestones"] as const) {
    const value = search[key];
    // A single hand-typed value (`?tags=ui`) counts as a list of one.
    const list = (Array.isArray(value) ? value : [value]).map(text).filter((entry): entry is string => typeof entry === "string" && entry !== "");
    if (list.length > 0) result[key] = list;
  }
  return result;
}

/** Board URL state: the baseline being compared (overlay by default) and the filters. */
export interface BoardSearch {
  baseline?: string;
  compare?: CompareMode;
  q?: string;
  /** resource ids; "none" = unassigned */
  people?: string[];
  tags?: string[];
  /** section ids */
  sections?: string[];
  /** milestone ids */
  milestones?: string[];
}
const boardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/p/$projectId",
  component: BoardPage,
  validateSearch: validateBoardSearch,
});
/** A board opened through a share link: outside the signed-in layout (no sidebar; may be anonymous). */
const shareRoute = createRoute({ ...needsServer, getParentRoute: () => rootRoute, path: "/s/$token", component: SharePage, validateSearch: validateBoardSearch });
const teamRoute = createRoute({ getParentRoute: () => appRoute, path: "/team", component: TeamPage });
const settingsRoute = createRoute({ getParentRoute: () => appRoute, path: "/settings", component: SettingsPage });

const routeTree = rootRoute.addChildren([
  setupRoute,
  loginRoute,
  changePasswordRoute,
  setUpTwoFactorRoute,
  connectRoute,
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
