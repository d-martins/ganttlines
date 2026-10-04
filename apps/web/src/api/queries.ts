import type {
  LocationBody,
  LocationDto,
  PublicHolidayDto,
  AboutDto,
  ActivityDto,
  BaselineDto,
  BaselineSnapshotDto,
  CalendarDto,
  CommentDto,
  CommentsDto,
  CreatedShareLinkDto,
  CreateShareLinkBody,
  CreateProjectBody,
  CreateResourceBody,
  CreateUserBody,
  HighlightBody,
  HighlightDto,
  HolidayBody,
  ProjectDto,
  ProjectStateDto,
  ResourceDto,
  ShareInfoDto,
  ShareLinkDto,
  TimeOffBody,
  UpdateProjectBody,
  UpdateResourceBody,
  UpdateUserBody,
  UserDto,
} from "@ganttlines/protocol";
import { infiniteQueryOptions, queryOptions, useMutation, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./client";

export const keys = {
  setup: ["setup"] as const,
  providers: ["providers"] as const,
  about: ["about"] as const,
  me: ["me"] as const,
  projects: (archived: boolean) => ["projects", { archived }] as const,
  users: ["users"] as const,
  calendar: ["calendar"] as const,
  resources: ["resources"] as const,
  /** everything cached for one project starts with this, so it can be dropped in one go */
  project: (id: string) => ["project", id] as const,
  highlights: (id: string) => ["project", id, "highlights"] as const,
  baselines: (id: string) => ["project", id, "baselines"] as const,
  baseline: (id: string, baselineId: string) => ["project", id, "baseline", baselineId] as const,
  comments: (id: string, taskId: string) => ["project", id, "comments", taskId] as const,
  activity: (id: string, rowId: string) => ["project", id, "activity", rowId] as const,
  shareLinks: (id: string) => ["project", id, "share-links"] as const,
  shareInfo: (token: string) => ["share", token] as const,
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

export const projectList = (includeArchived: boolean) =>
  queryOptions({
    queryKey: keys.projects(includeArchived),
    queryFn: async () => (await api<{ projects: ProjectDto[] }>("GET", `/api/projects${includeArchived ? "?archived=true" : ""}`)).projects,
  });

export const userList = queryOptions({
  queryKey: keys.users,
  queryFn: async () => (await api<{ users: UserDto[] }>("GET", "/api/users")).users,
});

export const calendar = queryOptions({ queryKey: keys.calendar, queryFn: () => api<CalendarDto>("GET", "/api/calendar") });

export const resourceList = queryOptions({
  queryKey: keys.resources,
  queryFn: async () => (await api<{ resources: ResourceDto[] }>("GET", "/api/resources")).resources,
});

/** The board's rows are kept by the sync client (not the query cache); this is its first load. */
export const loadProjectState = (projectId: string) => api<ProjectStateDto>("GET", `/api/projects/${projectId}/state`);

export const highlightList = (projectId: string) =>
  queryOptions({
    queryKey: keys.highlights(projectId),
    queryFn: async () => (await api<{ highlights: HighlightDto[] }>("GET", `/api/projects/${projectId}/highlights`)).highlights,
  });

export const baselineList = (projectId: string) =>
  queryOptions({
    queryKey: keys.baselines(projectId),
    queryFn: async () => (await api<{ baselines: BaselineDto[] }>("GET", `/api/projects/${projectId}/baselines`)).baselines,
  });

/** A saved baseline's dates. They never change, so they are fetched once. */
export const baselineSnapshot = (projectId: string, baselineId: string) =>
  queryOptions({
    queryKey: keys.baseline(projectId, baselineId),
    queryFn: () => api<BaselineSnapshotDto>("GET", `/api/baselines/${baselineId}`),
    staleTime: Infinity,
  });

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
  queryFn: () => api<{ oidc: { name: string } | null; passwordReset: boolean }>("GET", "/api/auth/providers"),
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
export const useEnableTwoFactor = () => useApiMutation((code: string) => api<{ recoveryCodes: string[] }>("POST", "/api/auth/2fa/enable", { code }), refreshMe);
export const useDisableTwoFactor = () => useApiMutation((password: string) => api<{ user: UserDto }>("POST", "/api/auth/2fa/disable", { password }), refreshMe);
export const useLogout = () => {
  const client = useQueryClient();
  return useMutation({ mutationFn: () => api<void>("POST", "/api/auth/logout"), onSuccess: () => client.clear() });
};
export const useChangePassword = () =>
  useApiMutation((body: { currentPassword: string; newPassword: string }) => api<void>("POST", "/api/auth/password", body), refreshAuth);

export const useCreateProject = () => useApiMutation((body: CreateProjectBody) => api<{ project: ProjectDto }>("POST", "/api/projects", body), refreshProjects);
export const useUpdateProject = () =>
  useApiMutation(({ id, ...body }: UpdateProjectBody & { id: string }) => api<{ project: ProjectDto }>("PATCH", `/api/projects/${id}`, body), refreshProjects);

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

export const useSetWorkingWeekdays = () =>
  useApiMutation((workingWeekdays: number[]) => api<CalendarDto>("PUT", "/api/calendar/working-weekdays", { workingWeekdays }), refreshCalendar);
export const useCreateResource = () => useApiMutation((body: CreateResourceBody) => api<{ resource: ResourceDto }>("POST", "/api/resources", body), refreshCalendar);
export const useUpdateResource = () =>
  useApiMutation(({ id, ...body }: UpdateResourceBody & { id: string }) => api<{ resource: ResourceDto }>("PATCH", `/api/resources/${id}`, body), refreshCalendar);
export const useSaveHoliday = () =>
  useApiMutation(({ id, ...body }: HolidayBody & { id?: string }) => (id ? api("PUT", `/api/holidays/${id}`, body) : api("POST", "/api/holidays", body)), refreshCalendar);
export const useDeleteHoliday = () => useApiMutation((id: string) => api<void>("DELETE", `/api/holidays/${id}`), refreshCalendar);
export const useSaveTimeOff = () =>
  useApiMutation(({ id, ...body }: TimeOffBody & { id?: string }) => (id ? api("PUT", `/api/time-off/${id}`, body) : api("POST", "/api/time-off", body)), refreshCalendar);
export const useSaveLocation = () =>
  useApiMutation(
    ({ id, ...body }: LocationBody & { id?: string }) => (id ? api<{ location: LocationDto }>("PUT", `/api/locations/${id}`, body) : api<{ location: LocationDto }>("POST", "/api/locations", body)),
    refreshCalendar,
  );
export const useDeleteLocation = () => useApiMutation((id: string) => api<void>("DELETE", `/api/locations/${id}`), refreshCalendar);
export const useImportHolidays = () =>
  useApiMutation(({ id, holidays }: { id: string; holidays: { name: string; startDate: string; endDate: string }[] }) => api<{ added: number }>("POST", `/api/locations/${id}/holidays`, { holidays }), refreshCalendar);
/** Countries (and their regions) with public holiday data. */
export const holidayCountries = queryOptions({
  queryKey: ["public-holidays", "countries"],
  queryFn: () => api<{ countries: { code: string; name: string }[] }>("GET", "/api/public-holidays/countries"),
  staleTime: Infinity,
});
export const holidayRegions = (country: string) =>
  queryOptions({
    queryKey: ["public-holidays", "regions", country],
    queryFn: () => api<{ regions: { code: string; name: string }[] }>("GET", `/api/public-holidays/countries/${country}/regions`),
    staleTime: Infinity,
  });
/** A location's public holidays for a year, marking those already added. */
export const locationPublicHolidays = (id: string, year: number) =>
  queryOptions({
    queryKey: [...keys.calendar, "public-holidays", id, year],
    queryFn: () => api<{ holidays: PublicHolidayDto[] }>("GET", `/api/locations/${id}/public-holidays?year=${year}`),
  });
export const useDeleteTimeOff = () => useApiMutation((id: string) => api<void>("DELETE", `/api/time-off/${id}`), refreshCalendar);

/** Highlights of one project (the server broadcasts the new list; the refetch covers a missed one). */
const refreshHighlights = (projectId: string) => (client: QueryClient) => client.invalidateQueries({ queryKey: keys.highlights(projectId) });
export const useSaveHighlight = (projectId: string) =>
  useApiMutation(
    ({ id, ...body }: HighlightBody & { id?: string }) =>
      id ? api<{ highlight: HighlightDto }>("PUT", `/api/highlights/${id}`, body) : api<{ highlight: HighlightDto }>("POST", `/api/projects/${projectId}/highlights`, body),
    refreshHighlights(projectId),
  );
export const useDeleteHighlight = (projectId: string) => useApiMutation((id: string) => api<void>("DELETE", `/api/highlights/${id}`), refreshHighlights(projectId));

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
    mutationFn: (id: string) => api<void>("DELETE", `/api/projects/${id}`),
    onSuccess: (_result, id) => {
      client.removeQueries({ queryKey: keys.project(id) });
      return client.invalidateQueries({ queryKey: ["projects"] });
    },
  });
};

/** Saves the board's current dates as a baseline (the server broadcasts the new list). */
export const useCreateBaseline = (projectId: string) =>
  useApiMutation(
    (name: string) => api<{ baseline: BaselineDto }>("POST", `/api/projects/${projectId}/baselines`, { name }),
    (client) => client.invalidateQueries({ queryKey: keys.baselines(projectId) }),
  );
export const useDeleteBaseline = (projectId: string) =>
  useApiMutation((id: string) => api<void>("DELETE", `/api/baselines/${id}`), (client) => client.invalidateQueries({ queryKey: keys.baselines(projectId) }));
