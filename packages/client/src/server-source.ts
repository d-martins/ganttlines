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
import { ApiError, type ApiFn } from "./api";
import type { BoardConnection, CountryDto, SocketLike, WorkspaceCapabilities, WorkspaceSource } from "./source";

export interface ServerSourceOptions {
  api: ApiFn;
  /** opens a board's live link (a WebSocket to /ws) */
  openLink: () => SocketLike;
}

/** The workspace on a GanttLines server: its REST API and its board WebSocket. */
export class ServerSource implements WorkspaceSource {
  readonly kind = "server";
  readonly capabilities: WorkspaceCapabilities = { accounts: true, sharing: true, comments: true, activity: true, presence: true, aiAccess: true, serverSettings: true };

  constructor(private readonly options: ServerSourceOptions) {}

  private get api(): ApiFn {
    return this.options.api;
  }

  async listProjects(): Promise<ProjectDto[]> {
    return (await this.api<{ projects: ProjectDto[] }>("GET", "/api/projects?archived=true")).projects;
  }
  async createProject(body: CreateProjectBody): Promise<ProjectDto> {
    return (await this.api<{ project: ProjectDto }>("POST", "/api/projects", body)).project;
  }
  async updateProject(id: string, body: UpdateProjectBody): Promise<ProjectDto> {
    return (await this.api<{ project: ProjectDto }>("PATCH", `/api/projects/${id}`, body)).project;
  }
  async deleteProject(id: string): Promise<void> {
    await this.api<void>("DELETE", `/api/projects/${id}`);
  }
  openBoard(projectId: string): BoardConnection {
    return {
      load: () => this.api<ProjectStateDto>("GET", `/api/projects/${projectId}/state`),
      openLink: () => this.options.openLink(),
      isFatal: (error) => error instanceof ApiError && error.status >= 400 && error.status < 500,
    };
  }

  async highlights(projectId: string): Promise<HighlightDto[]> {
    return (await this.api<{ highlights: HighlightDto[] }>("GET", `/api/projects/${projectId}/highlights`)).highlights;
  }
  async saveHighlight(projectId: string, body: HighlightBody, id?: string): Promise<HighlightDto> {
    const saved = id
      ? await this.api<{ highlight: HighlightDto }>("PUT", `/api/highlights/${id}`, body)
      : await this.api<{ highlight: HighlightDto }>("POST", `/api/projects/${projectId}/highlights`, body);
    return saved.highlight;
  }
  async deleteHighlight(_projectId: string, id: string): Promise<void> {
    await this.api<void>("DELETE", `/api/highlights/${id}`);
  }
  async baselines(projectId: string): Promise<BaselineDto[]> {
    return (await this.api<{ baselines: BaselineDto[] }>("GET", `/api/projects/${projectId}/baselines`)).baselines;
  }
  baselineSnapshot(_projectId: string, baselineId: string): Promise<BaselineSnapshotDto> {
    return this.api<BaselineSnapshotDto>("GET", `/api/baselines/${baselineId}`);
  }
  async createBaseline(projectId: string, name: string): Promise<BaselineDto> {
    return (await this.api<{ baseline: BaselineDto }>("POST", `/api/projects/${projectId}/baselines`, { name })).baseline;
  }
  async deleteBaseline(_projectId: string, baselineId: string): Promise<void> {
    await this.api<void>("DELETE", `/api/baselines/${baselineId}`);
  }

  calendar(): Promise<CalendarDto> {
    return this.api<CalendarDto>("GET", "/api/calendar");
  }
  async resources(): Promise<ResourceDto[]> {
    return (await this.api<{ resources: ResourceDto[] }>("GET", "/api/resources")).resources;
  }
  setWorkingWeekdays(workingWeekdays: number[]): Promise<CalendarDto> {
    return this.api<CalendarDto>("PUT", "/api/calendar/working-weekdays", { workingWeekdays });
  }
  async createResource(body: CreateResourceBody): Promise<ResourceDto> {
    return (await this.api<{ resource: ResourceDto }>("POST", "/api/resources", body)).resource;
  }
  async updateResource(id: string, body: UpdateResourceBody): Promise<ResourceDto> {
    return (await this.api<{ resource: ResourceDto }>("PATCH", `/api/resources/${id}`, body)).resource;
  }
  async saveHoliday(body: HolidayBody, id?: string): Promise<HolidayDto> {
    const saved = id ? await this.api<{ holiday: HolidayDto }>("PUT", `/api/holidays/${id}`, body) : await this.api<{ holiday: HolidayDto }>("POST", "/api/holidays", body);
    return saved.holiday;
  }
  async deleteHoliday(id: string): Promise<void> {
    await this.api<void>("DELETE", `/api/holidays/${id}`);
  }
  async saveTimeOff(body: TimeOffBody, id?: string): Promise<TimeOffDto> {
    const saved = id ? await this.api<{ timeOff: TimeOffDto }>("PUT", `/api/time-off/${id}`, body) : await this.api<{ timeOff: TimeOffDto }>("POST", "/api/time-off", body);
    return saved.timeOff;
  }
  async deleteTimeOff(id: string): Promise<void> {
    await this.api<void>("DELETE", `/api/time-off/${id}`);
  }
  async saveLocation(body: LocationBody, id?: string): Promise<LocationDto> {
    const saved = id ? await this.api<{ location: LocationDto }>("PUT", `/api/locations/${id}`, body) : await this.api<{ location: LocationDto }>("POST", "/api/locations", body);
    return saved.location;
  }
  async deleteLocation(id: string): Promise<void> {
    await this.api<void>("DELETE", `/api/locations/${id}`);
  }
  async importHolidays(locationId: string, holidays: { name: string; startDate: string; endDate: string }[]): Promise<number> {
    return (await this.api<{ added: number }>("POST", `/api/locations/${locationId}/holidays`, { holidays })).added;
  }

  async holidayCountries(): Promise<CountryDto[]> {
    return (await this.api<{ countries: CountryDto[] }>("GET", "/api/public-holidays/countries")).countries;
  }
  async holidayRegions(country: string): Promise<CountryDto[]> {
    return (await this.api<{ regions: CountryDto[] }>("GET", `/api/public-holidays/countries/${country}/regions`)).regions;
  }
  async locationPublicHolidays(locationId: string, year: number): Promise<PublicHolidayDto[]> {
    return (await this.api<{ holidays: PublicHolidayDto[] }>("GET", `/api/locations/${locationId}/public-holidays?year=${year}`)).holidays;
  }
}
