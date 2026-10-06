import type {
  LocationBody,
  AboutDto,
  ActivityDto,
  CommentDto,
  CommentCountsDto,
  CommentsDto,
  CreatedShareLinkDto,
  CreateShareLinkBody,
  CreateProjectBody,
  CreateResourceBody,
  CreateUserBody,
  HighlightBody,
  HolidayBody,
  ProjectDto,
  ShareInfoDto,
  ShareLinkDto,
  TimeOffBody,
  UpdateProjectBody,
  UpdateResourceBody,
  TwoFactorRequirement,
  CreateMcpTokenBody,
  McpConnectionDto,
  McpScope,
  McpSettingsBody,
  McpSettingsDto,
  OAuthConsentBody,
  OAuthRequestDto,
  UpdateUserBody,
  UserDto,
} from "@ganttlines/protocol";
import { infiniteQueryOptions, queryOptions, useMutation, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./client";
import { workspace } from "../workspace";

export const keys = {
  setup: ["setup"] as const,
  providers: ["providers"] as const,
  about: ["about"] as const,
  me: ["me"] as const,
  projects: ["projects"] as const,
  users: ["users"] as const,
  calendar: ["calendar"] as const,
  resources: ["resources"] as const,
  /** everything cached for one project starts with this, so it can be dropped in one go */
  project: (id: string) => ["project", id] as const,
  highlights: (id: string) => ["project", id, "highlights"] as const,
  baselines: (id: string) => ["project", id, "baselines"] as const,
  baseline: (id: string, baselineId: string) => ["project", id, "baseline", baselineId] as const,
  comments: (id: string, taskId: string) => ["project", id, "comments", taskId] as const,
  commentCounts: (id: string) => ["project", id, "comment-counts"] as const,
  activity: (id: string, rowId: string) => ["project", id, "activity", rowId] as const,
  shareLinks: (id: string) => ["project", id, "share-links"] as const,
  shareInfo: (token: string) => ["share", token] as const,
  mcpSettings: ["mcp-settings"] as const,
  mcpAvailable: ["mcp-available"] as const,
  /** your AI app connections, or (all) everyone's */
  mcpConnections: (all: boolean) => ["mcp-connections", { all }] as const,
  oauthRequest: (request: string) => ["oauth-request", request] as const,
  /** every activity list of a project (refreshed whenever the project changes) */
  allActivity: (id: string) => ["project", id, "activity"] as const,
};

export const setupStatus = queryOptions({
  queryKey: keys.setup,
  queryFn: () => api<{ needsSetup: boolean }>("GET", "/api/setup"),
});

/** The signed-in user, or null when nobody is signed in. */
export const currentUser = queryOptions({
  queryKey: keys.me,
  queryFn: async () => {
    try {
      return (await api<{ user: UserDto }>("GET", "/api/auth/me")).user;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  },
});

const unarchived = (projects: ProjectDto[]) => projects.filter((project) => !project.archived);

/** Projects, archived ones included or not — one request either way (the list is shared). */
export const projectList = (includeArchived: boolean) =>
  queryOptions({
    queryKey: keys.projects,
    queryFn: () => workspace().listProjects(),
    ...(includeArchived ? {} : { select: unarchived }),
  });
export const userList = queryOptions({
  queryKey: keys.users,
  queryFn: async () => (await api<{ users: UserDto[] }>("GET", "/api/users")).users,
});

export const calendar = queryOptions({ queryKey: keys.calendar, queryFn: () => workspace().calendar() });
export const resourceList = queryOptions({ queryKey: keys.resources, queryFn: () => workspace().resources() });
export const highlightList = (projectId: string) =>
  queryOptions({ queryKey: keys.highlights(projectId), queryFn: () => workspace().highlights(projectId) });
export const baselineList = (projectId: string) =>
  queryOptions({ queryKey: keys.baselines(projectId), queryFn: () => workspace().baselines(projectId) });
/** A saved baseline's dates. They never change, so they are fetched once. */
export const baselineSnapshot = (projectId: string, baselineId: string) =>
  queryOptions({ queryKey: keys.baseline(projectId, baselineId), queryFn: () => workspace().baselineSnapshot(projectId, baselineId), staleTime: Infinity });
/** A mutation that refreshes the given queries when it succeeds. */
function useApiMutation<TInput, TResult>(run: (input: TInput) => Promise<TResult>, invalidate: (client: QueryClient) => unknown) {
  const client = useQueryClient();
  return useMutation({ mutationFn: run, onSuccess: () => invalidate(client) });
}

/**
 * After changing the password, the cached "who am I" answers are dropped (not just marked stale):
 * otherwise the next screen would briefly act on the old answer and bounce back.
 */
const refreshAuth = (client: QueryClient) => {
  client.removeQueries({ queryKey: keys.me });
  client.removeQueries({ queryKey: keys.setup });
};

/** Signing in (or setting up) may switch to a different person: drop everything cached for the previous one. */
const startSession = (client: QueryClient) => client.clear();
const refreshProjects = (client: QueryClient) => client.invalidateQueries({ queryKey: ["projects"] });
const refreshCalendar = (client: QueryClient) => Promise.all([client.invalidateQueries({ queryKey: keys.calendar }), client.invalidateQueries({ queryKey: keys.resources })]);

/** Sign-in options besides email and password (single sign-on), for the sign-in page. */
export const signInProviders = queryOptions({
  queryKey: keys.providers,
  // `firstAdmin`: on a fresh install, signing in with the provider can create the admin.
  queryFn: () => api<{ oidc: { name: string; firstAdmin?: true } | null; passwordReset: boolean }>("GET", "/api/auth/providers"),
  staleTime: Infinity,
});

export const useSetup = () =>
  useApiMutation((body: { email: string; name: string; password: string; setupCode: string }) => api<{ user: UserDto }>("POST", "/api/setup", body), startSession);
/** "Forgot your password?" — emails a one-time link. */
export const useRequestPasswordReset = () => useApiMutation((email: string) => api<void>("POST", "/api/auth/forgot", { email }), () => undefined);
/** Choosing a password from an emailed link (invitation or reset); signs in. */
export const useChoosePassword = () =>
  useApiMutation((body: { token: string; password: string }) => api<SignInResult>("POST", "/api/auth/reset", body), startSession);
export const useSendTestEmail = () => useApiMutation(() => api<{ sentTo: string }>("POST", "/api/settings/test-email"), () => undefined);

/** Signed in — or, with two-factor on, the proof for the code step. */
export type SignInResult = { user: UserDto; twoFactor?: undefined } | { twoFactor: { challenge: string }; user?: undefined };
export const useLogin = () => useApiMutation((body: { email: string; password: string }) => api<SignInResult>("POST", "/api/auth/login", body), startSession);
/** The two-factor step: a code from the app, or a recovery code. */
export const useLoginCode = () => useApiMutation((body: { challenge: string; code: string }) => api<{ user: UserDto }>("POST", "/api/auth/login/2fa", body), startSession);
const refreshMe = (client: QueryClient) => client.invalidateQueries({ queryKey: keys.me });
export const useTwoFactorSetup = () => useApiMutation(() => api<{ secret: string; otpauthUrl: string; qrSvg: string }>("POST", "/api/auth/2fa/setup"), () => undefined);
// Who is signed in is refreshed once the recovery codes are put away (see TwoFactorSetup).
export const useEnableTwoFactor = () => useApiMutation((code: string) => api<{ recoveryCodes: string[] }>("POST", "/api/auth/2fa/enable", { code }), () => undefined);
export const useDisableTwoFactor = () => useApiMutation((password: string) => api<{ user: UserDto }>("POST", "/api/auth/2fa/disable", { password }), refreshMe);
export const useLogout = () => {
  const client = useQueryClient();
  return useMutation({ mutationFn: () => api<void>("POST", "/api/auth/logout"), onSuccess: () => client.clear() });
};
export const useChangePassword = () =>
  useApiMutation((body: { currentPassword: string; newPassword: string }) => api<void>("POST", "/api/auth/password", body), refreshAuth);

export const useCreateProject = () => useApiMutation((body: CreateProjectBody) => workspace().createProject(body), refreshProjects);
export const useUpdateProject = () => useApiMutation(({ id, ...body }: UpdateProjectBody & { id: string }) => workspace().updateProject(id, body), refreshProjects);
const refreshUsers = (client: QueryClient) =>
  Promise.all([
    client.invalidateQueries({ queryKey: keys.users }),
    client.invalidateQueries({ queryKey: keys.resources }),
    client.invalidateQueries({ queryKey: keys.me }),
  ]);
export const useCreateUser = () =>
  useApiMutation(
    // With email set up the person is invited (no password shown); otherwise — or if sending failed — a temporary password.
    (body: CreateUserBody) => api<{ user: UserDto; invited?: true; temporaryPassword?: string; inviteFailed?: true }>("POST", "/api/users", body),
    refreshUsers,
  );
/** For someone who lost their authenticator: turns their two-factor off. */
export const useAdminDisableTwoFactor = () => useApiMutation((id: string) => api<{ user: UserDto }>("POST", `/api/users/${id}/disable-2fa`), refreshUsers);
export const useUpdateUser = () =>
  useApiMutation(({ id, ...body }: UpdateUserBody & { id: string }) => api<{ user: UserDto }>("PATCH", `/api/users/${id}`, body), refreshUsers);
export const useResetPassword = () =>
  useApiMutation((id: string) => api<{ temporaryPassword: string }>("POST", `/api/users/${id}/reset-password`), refreshUsers);
export const useDeleteUser = () => useApiMutation((id: string) => api<void>("DELETE", `/api/users/${id}`), refreshUsers);

/** The running version, and for admins whether a newer one is out (the server asks GitHub at most daily). */
export const about = queryOptions({ queryKey: keys.about, queryFn: () => api<AboutDto>("GET", "/api/about"), staleTime: 60 * 60 * 1000 });
export const useSetUpdateCheck = () =>
  useApiMutation((enabled: boolean) => api<{ enabled: boolean }>("PUT", "/api/settings/update-check", { enabled }), (client) => client.invalidateQueries({ queryKey: keys.about }));

export const useSetRequireTwoFactor = () =>
  useApiMutation(
    (require: TwoFactorRequirement) => api<{ require: TwoFactorRequirement }>("PUT", "/api/settings/require-two-factor", { require }),
    (client) => client.invalidateQueries({ queryKey: keys.about }),
  );

export const mcpSettings = queryOptions({
  queryKey: keys.mcpSettings,
  queryFn: () => api<McpSettingsDto>("GET", "/api/settings/mcp"),
});
export const mcpConnections = (all: boolean) =>
  queryOptions({
    queryKey: keys.mcpConnections(all),
    queryFn: async () => (await api<{ connections: McpConnectionDto[] }>("GET", `/api/mcp/connections${all ? "?all=true" : ""}`)).connections,
  });
/** What an AI app asks for, on the "Allow access?" page. */
export const oauthRequest = (request: string) =>
  queryOptions({
    queryKey: keys.oauthRequest(request),
    queryFn: () => api<OAuthRequestDto>("GET", `/api/oauth/request?request=${encodeURIComponent(request)}`),
    retry: false,
  });
export const useSaveMcpSettings = () =>
  useApiMutation(
    (body: McpSettingsBody) => api<McpSettingsDto>("PUT", "/api/settings/mcp", body),
    // What everyone's Settings offers follows the switch (e.g. the Connected AI apps section).
    (client) => Promise.all([client.invalidateQueries({ queryKey: keys.mcpSettings }), client.invalidateQueries({ queryKey: keys.mcpAvailable })]),
  );
/** Whether AI apps can connect, where, and which groups the signed-in person can grant. */
export const mcpAvailable = queryOptions({
  queryKey: keys.mcpAvailable,
  queryFn: () => api<{ enabled: boolean; url: string; scopes: McpScope[] }>("GET", "/api/mcp/available"),
});
export const useCreateMcpToken = () =>
  useApiMutation(
    (body: CreateMcpTokenBody) => api<{ token: string; connection: McpConnectionDto }>("POST", "/api/mcp/tokens", body),
    (client) => client.invalidateQueries({ queryKey: ["mcp-connections"] }),
  );
export const useDisconnectApp = () =>
  useApiMutation((id: string) => api<void>("DELETE", `/api/mcp/connections/${id}`), (client) => client.invalidateQueries({ queryKey: ["mcp-connections"] }));
/** Approving (or declining) an AI app's request; answers where to send the browser back to the app. */
export const useOAuthConsent = () => useMutation({ mutationFn: (body: OAuthConsentBody) => api<{ redirect: string }>("POST", "/api/oauth/consent", body) });

export const useSetWorkingWeekdays = () => useApiMutation((workingWeekdays: number[]) => workspace().setWorkingWeekdays(workingWeekdays), refreshCalendar);
export const useCreateResource = () => useApiMutation((body: CreateResourceBody) => workspace().createResource(body), refreshCalendar);
export const useUpdateResource = () => useApiMutation(({ id, ...body }: UpdateResourceBody & { id: string }) => workspace().updateResource(id, body), refreshCalendar);
export const useSaveHoliday = () => useApiMutation(({ id, ...body }: HolidayBody & { id?: string }) => workspace().saveHoliday(body, id), refreshCalendar);
export const useDeleteHoliday = () => useApiMutation((id: string) => workspace().deleteHoliday(id), refreshCalendar);
export const useSaveTimeOff = () => useApiMutation(({ id, ...body }: TimeOffBody & { id?: string }) => workspace().saveTimeOff(body, id), refreshCalendar);
export const useSaveLocation = () => useApiMutation(({ id, ...body }: LocationBody & { id?: string }) => workspace().saveLocation(body, id), refreshCalendar);
export const useDeleteLocation = () => useApiMutation((id: string) => workspace().deleteLocation(id), refreshCalendar);
export const useImportHolidays = () =>
  useApiMutation(
    async ({ id, holidays }: { id: string; holidays: { name: string; startDate: string; endDate: string }[] }) => ({ added: await workspace().importHolidays(id, holidays) }),
    refreshCalendar,
  );
/** Countries (and their regions) with public holiday data. */
export const holidayCountries = queryOptions({
  queryKey: ["public-holidays", "countries"],
  queryFn: async () => ({ countries: await workspace().holidayCountries() }),
  staleTime: Infinity,
});
export const holidayRegions = (country: string) =>
  queryOptions({
    queryKey: ["public-holidays", "regions", country],
    queryFn: async () => ({ regions: await workspace().holidayRegions(country) }),
    staleTime: Infinity,
  });
/** A location's public holidays for a year, marking those already added. */
export const locationPublicHolidays = (id: string, year: number) =>
  queryOptions({
    queryKey: [...keys.calendar, "public-holidays", id, year],
    queryFn: async () => ({ holidays: await workspace().locationPublicHolidays(id, year) }),
  });
export const useDeleteTimeOff = () => useApiMutation((id: string) => workspace().deleteTimeOff(id), refreshCalendar);
/** Highlights of one project (the server broadcasts the new list; the refetch covers a missed one). */
const refreshHighlights = (projectId: string) => (client: QueryClient) => client.invalidateQueries({ queryKey: keys.highlights(projectId) });
export const useSaveHighlight = (projectId: string) =>
  useApiMutation(({ id, ...body }: HighlightBody & { id?: string }) => workspace().saveHighlight(projectId, body, id), refreshHighlights(projectId));
export const useDeleteHighlight = (projectId: string) => useApiMutation((id: string) => workspace().deleteHighlight(projectId, id), refreshHighlights(projectId));
const PAGE = 20;

/** A task's comments, newest first, a page at a time. */
export const taskComments = (projectId: string, taskId: string) =>
  infiniteQueryOptions({
    queryKey: keys.comments(projectId, taskId),
    queryFn: ({ pageParam }) =>
      api<CommentsDto>("GET", `/api/projects/${projectId}/comments?taskId=${taskId}&limit=${PAGE}${pageParam ? `&before=${pageParam}` : ""}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
  });

/** How many comments each task has (by task id), for the task list. */
export const commentCounts = (projectId: string) =>
  queryOptions({
    queryKey: keys.commentCounts(projectId),
    queryFn: async () => (await api<CommentCountsDto>("GET", `/api/projects/${projectId}/comment-counts`)).counts,
  });

/** A row's history, newest first, a page at a time. */
export const rowActivity = (projectId: string, rowId: string) =>
  infiniteQueryOptions({
    queryKey: keys.activity(projectId, rowId),
    queryFn: ({ pageParam }) =>
      api<ActivityDto>("GET", `/api/projects/${projectId}/activity?rowId=${rowId}&limit=${PAGE}${pageParam ? `&before=${pageParam}` : ""}`),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore,
  });

/**
 * Puts a comment into its task's cached list: replaced where it already is, otherwise added on top
 * (lists are newest first). Used for our own posts and for comments arriving over the WebSocket.
 */
export function upsertComment(client: QueryClient, projectId: string, comment: CommentDto): void {
  client.setQueryData<InfiniteData<CommentsDto, string | null>>(keys.comments(projectId, comment.taskId), (data) => {
    if (!data) return data;
    const exists = data.pages.some((page) => page.comments.some((entry) => entry.id === comment.id));
    const pages = exists
      ? data.pages.map((page) => ({ ...page, comments: page.comments.map((entry) => (entry.id === comment.id ? comment : entry)) }))
      : data.pages.map((page, index) => (index === 0 ? { ...page, comments: [comment, ...page.comments] } : page));
    return { ...data, pages };
  });
}

export const usePostComment = (projectId: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { taskId: string; body: string }) => api<{ comment: CommentDto }>("POST", `/api/projects/${projectId}/comments`, body),
    onSuccess: ({ comment }) => upsertComment(client, projectId, comment),
  });
};
export const useEditComment = (projectId: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) => api<{ comment: CommentDto }>("PATCH", `/api/comments/${id}`, { body }),
    onSuccess: ({ comment }) => upsertComment(client, projectId, comment),
  });
};
export const useDeleteComment = (projectId: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (comment: CommentDto) => api<void>("DELETE", `/api/comments/${comment.id}`),
    onSuccess: (_result, comment) => upsertComment(client, projectId, { ...comment, body: "", deleted: true }),
  });
};

/** What a share link opens and what the visitor still has to do (sign in / pick a name). */
export const shareInfo = (token: string) =>
  queryOptions({
    queryKey: keys.shareInfo(token),
    queryFn: () => api<ShareInfoDto>("GET", `/api/share/${encodeURIComponent(token)}`),
    retry: false,
  });

export const useVisitorName = (token: string) =>
  useApiMutation(
    (name: string) => api<{ visitor: { name: string } }>("POST", `/api/share/${encodeURIComponent(token)}/visitor`, { name }),
    (client) => client.invalidateQueries({ queryKey: keys.shareInfo(token) }),
  );

/** A project's share links (editors and admins), newest first, turned-off ones left out. */
export const shareLinkList = (projectId: string) =>
  queryOptions({
    queryKey: keys.shareLinks(projectId),
    queryFn: async () =>
      (await api<{ links: ShareLinkDto[] }>("GET", `/api/projects/${projectId}/share-links`)).links
        .filter((link) => !link.revoked)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  });
const refreshShareLinks = (projectId: string) => (client: QueryClient) => client.invalidateQueries({ queryKey: keys.shareLinks(projectId) });
export const useCreateShareLink = (projectId: string) =>
  useApiMutation((body: CreateShareLinkBody) => api<CreatedShareLinkDto>("POST", `/api/projects/${projectId}/share-links`, body), refreshShareLinks(projectId));
export const useUpdateShareLink = (projectId: string) =>
  useApiMutation(({ id, ...body }: { id: string; collaboration?: boolean; label?: string }) => api<{ link: ShareLinkDto }>("PATCH", `/api/share-links/${id}`, body), refreshShareLinks(projectId));
export const useRevokeShareLink = (projectId: string) => useApiMutation((id: string) => api<void>("DELETE", `/api/share-links/${id}`), refreshShareLinks(projectId));

/** Deletes an archived project for good; everything cached for it goes too. */
export const useDeleteProject = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => workspace().deleteProject(id),
    onSuccess: (_result, id) => {
      client.removeQueries({ queryKey: keys.project(id) });
      return client.invalidateQueries({ queryKey: ["projects"] });
    },
  });
};
/** Saves the board's current dates as a baseline (the server broadcasts the new list). */
export const useCreateBaseline = (projectId: string) =>
  useApiMutation((name: string) => workspace().createBaseline(projectId, name), (client) => client.invalidateQueries({ queryKey: keys.baselines(projectId) }));
export const useDeleteBaseline = (projectId: string) =>
  useApiMutation((id: string) => workspace().deleteBaseline(projectId, id), (client) => client.invalidateQueries({ queryKey: keys.baselines(projectId) }));