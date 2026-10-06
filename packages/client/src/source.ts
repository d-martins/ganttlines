import type {
  BaselineDto,
  BaselineSnapshotDto,
  CalendarDto,
  CreateProjectBody,
  CreateResourceBody,
  HighlightBody,
  HighlightDto,
  HolidayBody,
  HolidayDto,
  LocationBody,
  LocationDto,
  ProjectDto,
  ProjectStateDto,
  PublicHolidayDto,
  ResourceDto,
  TimeOffBody,
  TimeOffDto,
  UpdateProjectBody,
  UpdateResourceBody,
} from "@ganttlines/protocol";

/** The parts of a WebSocket a board's live link uses (fakes and in-memory links stand in for it). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
}

/** One board: its state, and a live link speaking the board protocol (JSON client/server messages). */
export interface BoardConnection {
  load(): Promise<ProjectStateDto>;
  openLink(): SocketLike;
  /** whether a failed `load` means the board can't be shown at all (gone, no access) */
  isFatal(error: unknown): boolean;
}

/**
 * What a source can do beyond the workspace itself — not today's settings (an admin switching AI
 * access off is a server setting the UI reads separately). The UI leaves out what's missing.
 */
export interface WorkspaceCapabilities {
  accounts: boolean;
  sharing: boolean;
  comments: boolean;
  activity: boolean;
  presence: boolean;
  aiAccess: boolean;
  serverSettings: boolean;
}

export interface CountryDto {
  code: string;
  name: string;
}

/**
 * Where a workspace lives — projects, boards, the team calendar, highlights and baselines — and
 * how to change it. Failures throw errors with the server's `status` and `code` (`ApiError`).
 */
export interface WorkspaceSource {
  readonly kind: "server" | "local";
  readonly capabilities: WorkspaceCapabilities;

  /** every project, archived ones included */
  listProjects(): Promise<ProjectDto[]>;
  createProject(body: CreateProjectBody): Promise<ProjectDto>;
  updateProject(id: string, body: UpdateProjectBody): Promise<ProjectDto>;
  /** archived projects only */
  deleteProject(id: string): Promise<void>;
  openBoard(projectId: string): BoardConnection;

  highlights(projectId: string): Promise<HighlightDto[]>;
  saveHighlight(projectId: string, body: HighlightBody, id?: string | undefined): Promise<HighlightDto>;
  deleteHighlight(projectId: string, id: string): Promise<void>;
  baselines(projectId: string): Promise<BaselineDto[]>;
  baselineSnapshot(projectId: string, baselineId: string): Promise<BaselineSnapshotDto>;
  createBaseline(projectId: string, name: string): Promise<BaselineDto>;
  deleteBaseline(projectId: string, baselineId: string): Promise<void>;

  calendar(): Promise<CalendarDto>;
  resources(): Promise<ResourceDto[]>;
  setWorkingWeekdays(workingWeekdays: number[]): Promise<CalendarDto>;
  createResource(body: CreateResourceBody): Promise<ResourceDto>;
  updateResource(id: string, body: UpdateResourceBody): Promise<ResourceDto>;
  saveHoliday(body: HolidayBody, id?: string | undefined): Promise<HolidayDto>;
  deleteHoliday(id: string): Promise<void>;
  saveTimeOff(body: TimeOffBody, id?: string | undefined): Promise<TimeOffDto>;
  deleteTimeOff(id: string): Promise<void>;
  saveLocation(body: LocationBody, id?: string | undefined): Promise<LocationDto>;
  deleteLocation(id: string): Promise<void>;
  /** returns how many were added */
  importHolidays(locationId: string, holidays: { name: string; startDate: string; endDate: string }[]): Promise<number>;

  holidayCountries(): Promise<CountryDto[]>;
  holidayRegions(country: string): Promise<CountryDto[]>;
  /** a location's public holidays for `year`, marking those already added */
  locationPublicHolidays(locationId: string, year: number): Promise<PublicHolidayDto[]>;
}
