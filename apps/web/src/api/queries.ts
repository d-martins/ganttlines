import type {
  BaselineDto,
  BaselineSnapshotDto,
  CalendarDto,
  CreateProjectBody,
  CreateResourceBody,
  CreateUserBody,
  HighlightBody,
  HighlightDto,
  HolidayBody,
  ProjectDto,
  ProjectStateDto,
  ResourceDto,
  TimeOffBody,
  UpdateProjectBody,
  UpdateResourceBody,
  UpdateUserBody,
  UserDto,
} from "@ganttlines/protocol";
import { queryOptions, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./client";

export const keys = {
  setup: ["setup"] as const,
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

export const useSetup = () =>
  useApiMutation((body: { email: string; name: string; password: string }) => api<{ user: UserDto }>("POST", "/api/setup", body), startSession);
export const useLogin = () => useApiMutation((body: { email: string; password: string }) => api<{ user: UserDto }>("POST", "/api/auth/login", body), startSession);
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
  useApiMutation((body: CreateUserBody) => api<{ user: UserDto; temporaryPassword: string }>("POST", "/api/users", body), refreshUsers);
export const useUpdateUser = () =>
  useApiMutation(({ id, ...body }: UpdateUserBody & { id: string }) => api<{ user: UserDto }>("PATCH", `/api/users/${id}`, body), refreshUsers);
export const useResetPassword = () =>
  useApiMutation((id: string) => api<{ temporaryPassword: string }>("POST", `/api/users/${id}/reset-password`), refreshUsers);
export const useDeleteUser = () => useApiMutation((id: string) => api<void>("DELETE", `/api/users/${id}`), refreshUsers);

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
