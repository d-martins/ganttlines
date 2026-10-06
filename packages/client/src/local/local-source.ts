import {
  applyCommand,
  baselineTasks,
  Calendar,
  diffRows,
  findTreeProblem,
  hasCycle,
  revertChanges,
  type Command,
  type ProjectState,
  type RowChange,
} from "@ganttlines/engine";
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
  ServerMessage,
  TimeOffBody,
  TimeOffDto,
  UpdateProjectBody,
  UpdateResourceBody,
  WorkspaceFile,
} from "@ganttlines/protocol";
import { ApiError } from "../api";
import type { BoardConnection, CountryDto, WorkspaceCapabilities, WorkspaceSource } from "../source";
import { LocalLink } from "./local-link";
import { checkFormat, emptyWorkspace, toCalendarDto, WORKSPACE_FORMAT, WORKSPACE_VERSION, type ProjectRecord, type StoredHoliday, type StoredResource, type WorkspaceRecord } from "./records";
import type { LocalStore } from "./store";
import { validation, type Validation } from "./validation";

export const AVATAR_COLORS = ["#4f8cff", "#a66cff", "#ff6fae", "#ff8a4c", "#2fbf71", "#1fb5c9", "#f5b82e", "#8a94a6"];
export const MAX_HIGHLIGHTS = 1_000;
export const MAX_BASELINES = 100;
/** WebSocket close code for "this project was deleted" (the board ends). */
export const CLOSE_PROJECT_DELETED = 4004;

export const badRequest = (message: string) => new ApiError(400, "invalid_request", message);
export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found`);
export const conflict = (message: string) => new ApiError(409, "conflict", message);

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const randomId = () => (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID();
const holidaysData = () => import("@ganttlines/holidays");

export interface LocalSourceOptions {
  now?: () => Date;
  newId?: () => string;
  /** A change couldn't be saved (quota, private mode…): the workspace keeps working in memory. */
  onStorageError?: (error: unknown) => void;
}

export const toProjectDto = (project: ProjectRecord): ProjectDto => ({ id: project.id, name: project.name, version: project.version, archived: project.archived });
const toResourceDto = (person: StoredResource): ResourceDto => ({ ...person, userId: null });

/**
 * A workspace kept in this browser: in memory, written through a `LocalStore`. It answers like the
 * server — same rules, limits, orderings and errors — and its boards speak the same live protocol.
 */
export class LocalSource implements WorkspaceSource {
  readonly kind = "local";
  readonly capabilities: WorkspaceCapabilities = { accounts: false, sharing: false, comments: false, activity: false, presence: false, aiAccess: false, serverSettings: false };

  private calendarCache: Calendar | null = null;
  private serialized: Promise<unknown> = Promise.resolve();
  protected readonly links = new Set<LocalLink>();
  /** per project: undo/redo stacks of command ids, and each command's changes (this visit only) */
  private readonly history = new Map<string, { undo: string[]; redo: string[]; changes: Map<string, RowChange[]> }>();

  private constructor(
    private readonly store: LocalStore,
    private workspace: WorkspaceRecord,
    private readonly projects: Map<string, ProjectRecord>,
    private readonly options: LocalSourceOptions,
  ) {}

  /** This browser's workspace (an empty one the first time). */
  static async open(store: LocalStore, options: LocalSourceOptions = {}): Promise<LocalSource> {
    const stored = await store.load();
    if (stored.workspace) checkFormat(stored.workspace);
    return new LocalSource(store, stored.workspace ?? emptyWorkspace(), new Map(stored.projects.map((project) => [project.id, project])), options);
  }

  // —— projects ——

  async listProjects(): Promise<ProjectDto[]> {
    return [...this.projects.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(toProjectDto);
  }

  createProject(input: CreateProjectBody): Promise<ProjectDto> {
    return this.serial(async () => {
      const { check, protocol } = await validation();
      const body = check(protocol.CreateProjectBody, input);
      const project: ProjectRecord = { id: this.newId(), name: body.name, archived: false, createdAt: this.now().toISOString(), version: 0, rows: [], highlights: [], baselines: [] };
      this.projects.set(project.id, project);
      await this.persist(() => this.store.saveProject(project));
      return toProjectDto(project);
    });
  }

  updateProject(id: string, input: UpdateProjectBody): Promise<ProjectDto> {
    return this.serial(async () => {
      const { check, protocol } = await validation();
      const body = check(protocol.UpdateProjectBody, input);
      const project = this.mustProject(id);
      if (body.name !== undefined) project.name = body.name;
      if (body.archived !== undefined) project.archived = body.archived;
      await this.persist(() => this.store.saveProject(project));
      this.broadcast(project.id, { type: "project", project: toProjectDto(project) });
      return toProjectDto(project);
    });
  }

  deleteProject(id: string): Promise<void> {
    return this.serial(async () => {
      const project = this.mustProject(id);
      if (!project.archived) throw conflict("Only archived projects can be deleted — archive it first");
      this.projects.delete(id);
      await this.persist(() => this.store.deleteProject(id));
      for (const link of [...this.links]) if (link.projectId === id) link.close(CLOSE_PROJECT_DELETED);
    });
  }

  openBoard(projectId: string): BoardConnection {
    return {
      load: async (): Promise<ProjectStateDto> => {
        const project = this.mustProject(projectId);
        return { project: toProjectDto(project), rows: copy(project.rows) };
      },
      openLink: () => {
        const link = new LocalLink(
          (from, data) => void this.receive(from, data),
          (gone) => this.links.delete(gone),
        );
        this.links.add(link);
        return link;
      },
      isFatal: (error) => error instanceof ApiError && error.status >= 400 && error.status < 500,
    };
  }

  // —— highlights and baselines ——

  async highlights(projectId: string): Promise<HighlightDto[]> {
    return copy(this.mustProject(projectId).highlights);
  }

  saveHighlight(projectId: string, input: HighlightBody, id?: string): Promise<HighlightDto> {
    return this.serial(async () => {
      const { check, protocol } = await validation();
      const body = check(protocol.HighlightBody, input);
      const project = this.mustProject(projectId);
      if (project.archived) throw conflict("This project is archived");
      let highlight: HighlightDto;
      if (id) {
        const existing = project.highlights.find((entry) => entry.id === id);
        if (!existing) throw notFound("Highlight");
        Object.assign(existing, body);
        highlight = existing;
      } else {
        if (project.highlights.length >= MAX_HIGHLIGHTS) throw conflict(`At most ${MAX_HIGHLIGHTS} highlights per project`);
        highlight = { id: this.newId(), ...body };
        project.highlights.push(highlight);
      }
      project.highlights.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
      await this.persist(() => this.store.saveProject(project));
      this.broadcast(project.id, { type: "highlights", projectId: project.id, highlights: copy(project.highlights) });
      return { ...highlight };
    });
  }

  deleteHighlight(projectId: string, id: string): Promise<void> {
    return this.serial(async () => {
      const project = this.mustProject(projectId);
      if (project.archived) throw conflict("This project is archived");
      if (!project.highlights.some((entry) => entry.id === id)) throw notFound("Highlight");
      project.highlights = project.highlights.filter((entry) => entry.id !== id);
      await this.persist(() => this.store.saveProject(project));
      this.broadcast(project.id, { type: "highlights", projectId: project.id, highlights: copy(project.highlights) });
    });
  }

  async baselines(projectId: string): Promise<BaselineDto[]> {
    return this.baselineList(this.mustProject(projectId));
  }

  async baselineSnapshot(projectId: string, baselineId: string): Promise<BaselineSnapshotDto> {
    const baseline = this.mustProject(projectId).baselines.find((entry) => entry.id === baselineId);
    if (!baseline) throw notFound("Baseline");
    return { baseline: { id: baseline.id, name: baseline.name, createdAt: baseline.createdAt, createdBy: baseline.createdBy }, tasks: copy(baseline.tasks) };
  }

  createBaseline(projectId: string, name: string): Promise<BaselineDto> {
    return this.serial(async () => {
      const { check, protocol } = await validation();
      const body = check(protocol.CreateBaselineBody, { name });
      const project = this.mustProject(projectId);
      if (project.archived) throw conflict("This project is archived");
      if (project.baselines.length >= MAX_BASELINES) throw conflict(`At most ${MAX_BASELINES} baselines per project`);
      const baseline = { id: this.newId(), name: body.name, createdAt: this.now().toISOString(), createdBy: "You", tasks: baselineTasks(stateOf(project), this.engineCalendar()) };
      project.baselines.push(baseline);
      await this.persist(() => this.store.saveProject(project));
      this.broadcast(project.id, { type: "baselines", projectId: project.id, baselines: this.baselineList(project) });
      return { id: baseline.id, name: baseline.name, createdAt: baseline.createdAt, createdBy: baseline.createdBy };
    });
  }

  deleteBaseline(projectId: string, baselineId: string): Promise<void> {
    return this.serial(async () => {
      const project = this.mustProject(projectId);
      if (!project.baselines.some((entry) => entry.id === baselineId)) throw notFound("Baseline");
      project.baselines = project.baselines.filter((entry) => entry.id !== baselineId);
      await this.persist(() => this.store.saveProject(project));
      this.broadcast(project.id, { type: "baselines", projectId: project.id, baselines: this.baselineList(project) });
    });
  }

  private baselineList(project: ProjectRecord): BaselineDto[] {
    return [...project.baselines]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .map((baseline) => ({ id: baseline.id, name: baseline.name, createdAt: baseline.createdAt, createdBy: baseline.createdBy }));
  }

  /** The whole workspace as a file (what Export saves). */
  exportFile(): WorkspaceFile {
    const { workingWeekdays, team, locations, holidays, timeOff } = copy(this.workspace);
    const projects = [...this.projects.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((project) => copy(project));
    return { format: WORKSPACE_FORMAT, version: WORKSPACE_VERSION, exportedAt: this.now().toISOString(), workingWeekdays, team, locations, holidays, timeOff, projects } as WorkspaceFile;
  }

  /** Replaces the whole workspace with a (checked) file's: open boards end, undo history starts afresh. */
  replaceWith(file: WorkspaceFile): Promise<void> {
    return this.serial(async () => {
      this.workspace = {
        format: WORKSPACE_FORMAT,
        version: WORKSPACE_VERSION,
        instanceVersion: this.workspace.instanceVersion + 1,
        workingWeekdays: [...file.workingWeekdays],
        team: copy(file.team),
        locations: copy(file.locations),
        holidays: copy(file.holidays),
        timeOff: copy(file.timeOff),
      };
      this.calendarCache = null;
      this.projects.clear();
      for (const project of copy(file.projects) as ProjectRecord[]) this.projects.set(project.id, project);
      this.history.clear();
      await this.persist(() => this.store.replaceAll(this.workspace, [...this.projects.values()]));
      for (const link of [...this.links]) link.close(CLOSE_PROJECT_DELETED);
    });
  }

  /** Empties the workspace (Clear workspace). */
  clear(): Promise<void> {
    const empty = emptyWorkspace();
    return this.replaceWith({ format: WORKSPACE_FORMAT, version: WORKSPACE_VERSION, exportedAt: this.now().toISOString(), workingWeekdays: empty.workingWeekdays, team: [], locations: [], holidays: [], timeOff: [], projects: [] } as WorkspaceFile);
  }

  // —— the team calendar ——

  async calendar(): Promise<CalendarDto> {
    return toCalendarDto(this.workspace);
  }

  async resources(): Promise<ResourceDto[]> {
    return this.workspace.team.map(toResourceDto);
  }

  setWorkingWeekdays(workingWeekdays: number[]): Promise<CalendarDto> {
    return this.serial(async () => {
      const { check, protocol } = await validation();
      const body = check(protocol.WorkingWeekdaysBody, { workingWeekdays });
      await this.changeCalendar((draft) => {
        draft.workingWeekdays = body.workingWeekdays;
      });
      return toCalendarDto(this.workspace);
    });
  }

  createResource(input: CreateResourceBody): Promise<ResourceDto> {
    return this.serial(async () => {
      const { check, protocol } = await validation();
      const body = check(protocol.CreateResourceBody, input);
      return this.changeCalendar((draft) => {
        const person: StoredResource = { id: this.newId(), name: body.name, avatarColor: body.avatarColor ?? AVATAR_COLORS[draft.team.length % AVATAR_COLORS.length]!, inactive: false, locationId: null };
        draft.team.push(person);
        return toResourceDto(person);
      });
    });
  }

  updateResource(id: string, input: UpdateResourceBody): Promise<ResourceDto> {
    return this.serial(async () => {
      const { check, protocol } = await validation();
      const body = check(protocol.UpdateResourceBody, input);
      return this.changeCalendar((draft) => {
        const person = draft.team.find((entry) => entry.id === id);
        if (!person) throw notFound("Team member");
        if (body.locationId && !draft.locations.some((location) => location.id === body.locationId)) throw badRequest("Unknown location");
        if (body.name) person.name = body.name;
        if (body.avatarColor) person.avatarColor = body.avatarColor;
        if (body.inactive !== undefined) person.inactive = body.inactive;
        if (body.locationId !== undefined) person.locationId = body.locationId;
        return toResourceDto(person);
      });
    });
  }

  saveHoliday(input: HolidayBody, id?: string): Promise<HolidayDto> {
    return this.serial(async () => {
      const { check, protocol } = await validation();
      const body = check(protocol.HolidayBody, input);
      const saved = await this.changeCalendar((draft) => {
        assertPeople(draft, body.appliesTo);
        assertLocations(draft, body.locationIds);
        const appliesToAll = body.appliesTo === "all";
        const columns = {
          name: body.name,
          startDate: body.startDate,
          endDate: body.endDate,
          appliesToAll,
          resourceIds: appliesToAll ? [] : [...new Set(body.appliesTo as string[])],
          locationIds: appliesToAll ? [] : [...new Set(body.locationIds)],
        };
        if (id) {
          const holiday = draft.holidays.find((entry) => entry.id === id);
          if (!holiday) throw notFound("Holiday");
          Object.assign(holiday, columns);
          return id;
        }
        if (draft.holidays.length >= protocol.CALENDAR_LIMITS.holidays) throw conflict(`At most ${protocol.CALENDAR_LIMITS.holidays} holidays`);
        const holiday: StoredHoliday = { id: this.newId(), ...columns };
        draft.holidays.push(holiday);
        return holiday.id;
      });
      return toCalendarDto(this.workspace).holidays.find((holiday) => holiday.id === saved)!;
    });
  }

  deleteHoliday(id: string): Promise<void> {
    return this.serial(() =>
      this.changeCalendar((draft) => {
        if (!draft.holidays.some((entry) => entry.id === id)) throw notFound("Holiday");
        draft.holidays = draft.holidays.filter((entry) => entry.id !== id);
      }),
    );
  }

  saveTimeOff(input: TimeOffBody, id?: string): Promise<TimeOffDto> {
    return this.serial(async () => {
      const { check, protocol } = await validation();
      const body = check(protocol.TimeOffBody, input);
      return this.changeCalendar((draft) => {
        assertPeople(draft, [body.resourceId]);
        if (id) {
          const entry = draft.timeOff.find((candidate) => candidate.id === id);
          if (!entry) throw notFound("Time off");
          Object.assign(entry, body);
          return { ...entry };
        }
        if (draft.timeOff.length >= protocol.CALENDAR_LIMITS.timeOff) throw conflict(`At most ${protocol.CALENDAR_LIMITS.timeOff} time-off entries`);
        const entry: TimeOffDto = { id: this.newId(), resourceId: body.resourceId, startDate: body.startDate, endDate: body.endDate, note: body.note };
        draft.timeOff.push(entry);
        return { ...entry };
      });
    });
  }

  deleteTimeOff(id: string): Promise<void> {
    return this.serial(() =>
      this.changeCalendar((draft) => {
        if (!draft.timeOff.some((entry) => entry.id === id)) throw notFound("Time off");
        draft.timeOff = draft.timeOff.filter((entry) => entry.id !== id);
      }),
    );
  }

  saveLocation(input: LocationBody, id?: string): Promise<LocationDto> {
    return this.serial(async () => {
      const { check, protocol } = await validation();
      const body = check(protocol.LocationBody, input);
      const holidays = await holidaysData();
      if (body.region && !body.country) throw badRequest("Choose the country of that region");
      if (body.country && !holidays.countries().some((entry) => entry.code === body.country)) throw badRequest("No public holiday data for that country");
      if (body.country && body.region && !holidays.regions(body.country).some((entry) => entry.code === body.region)) throw badRequest("Unknown region for that country");
      return this.changeCalendar((draft) => {
        const fields = { name: body.name, country: body.country, region: body.region };
        if (id) {
          const location = draft.locations.find((entry) => entry.id === id);
          if (!location) throw notFound("Location");
          Object.assign(location, fields);
          return { ...location };
        }
        const location: LocationDto = { id: this.newId(), ...fields };
        draft.locations.push(location);
        return { ...location };
      });
    });
  }

  deleteLocation(id: string): Promise<void> {
    return this.serial(() =>
      this.changeCalendar((draft) => {
        if (!draft.locations.some((entry) => entry.id === id)) throw notFound("Location");
        draft.holidays = draft.holidays.flatMap((holiday) => {
          if (!holiday.locationIds.includes(id)) return [holiday];
          const locationIds = holiday.locationIds.filter((other) => other !== id);
          return locationIds.length === 0 && holiday.resourceIds.length === 0 ? [] : [{ ...holiday, locationIds }];
        });
        for (const person of draft.team) if (person.locationId === id) person.locationId = null;
        draft.locations = draft.locations.filter((entry) => entry.id !== id);
      }),
    );
  }

  importHolidays(locationId: string, holidays: { name: string; startDate: string; endDate: string }[]): Promise<number> {
    return this.serial(async () => {
      const { check, protocol } = await validation();
      const body = check(protocol.ImportHolidaysBody, { holidays });
      return this.changeCalendar((draft) => {
        if (!draft.locations.some((entry) => entry.id === locationId)) throw notFound("Location");
        const have = new Set(draft.holidays.filter((holiday) => holiday.locationIds.includes(locationId)).map((holiday) => `${holiday.name}|${holiday.startDate}`));
        const fresh = body.holidays.filter((holiday) => !have.has(`${holiday.name}|${holiday.startDate}`));
        if (draft.holidays.length + fresh.length > protocol.CALENDAR_LIMITS.holidays) throw conflict(`At most ${protocol.CALENDAR_LIMITS.holidays} holidays`);
        for (const holiday of fresh) draft.holidays.push({ id: this.newId(), ...holiday, appliesToAll: false, resourceIds: [], locationIds: [locationId] });
        return fresh.length;
      });
    });
  }

  async holidayCountries(): Promise<CountryDto[]> {
    return (await holidaysData()).countries();
  }

  async holidayRegions(country: string): Promise<CountryDto[]> {
    return (await holidaysData()).regions(country.toUpperCase());
  }

  async locationPublicHolidays(locationId: string, year: number): Promise<PublicHolidayDto[]> {
    const location = this.workspace.locations.find((entry) => entry.id === locationId);
    if (!location) throw notFound("Location");
    if (!location.country) throw badRequest("Set the location's country first");
    if (!Number.isInteger(year) || year < 1970 || year > 2199) throw badRequest("Choose a year between 1970 and 2199");
    const added = new Set(this.workspace.holidays.filter((holiday) => holiday.locationIds.includes(locationId)).map((holiday) => `${holiday.name}|${holiday.startDate}`));
    return (await holidaysData()).publicHolidays(location.country, location.region, year).map((holiday) => ({ ...holiday, added: added.has(`${holiday.name}|${holiday.startDate}`) }));
  }

  // —— shared machinery ——

  /** A message from a board's link: join/leave, or an edit/undo/redo answered with ack or reject. */
  private async receive(link: LocalLink, data: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    let protocol: Validation["protocol"];
    try {
      ({ protocol } = await validation());
    } catch {
      // Answer anyway, so the board doesn't wait for an edit that will never be saved.
      const message = "Part of GanttLines couldn't be loaded — check your connection and reload the page";
      const commandId = (parsed as { commandId?: unknown } | null)?.commandId;
      if (typeof commandId === "string") link.deliver({ type: "reject", commandId, error: "unavailable", message });
      else link.deliver({ type: "error", message });
      return;
    }
    const result = protocol.ClientMessage.safeParse(parsed);
    if (!result.success) return;
    const message = result.data;
    if (message.type === "leave") {
      link.projectId = null;
      return;
    }
    if (message.type === "join") {
      const project = this.projects.get(message.projectId);
      if (!project) return link.deliver({ type: "error", message: "Project not found" });
      link.projectId = project.id;
      // There is no local command log: a board that is behind (or ahead) reloads.
      if (message.version !== project.version) link.deliver({ type: "reload", projectId: project.id });
      link.deliver({ type: "joined", projectId: project.id, version: project.version, instanceVersion: this.workspace.instanceVersion, viewers: [] });
      return;
    }
    const reject = (error: string, text: string) => link.deliver({ type: "reject", commandId: message.commandId, error, message: text });
    const projectId = link.projectId;
    if (!projectId) return reject("invalid", "Join a project first");
    try {
      if (message.type === "command") {
        const version = await this.apply(projectId, message.commandId, protocol.toEngineCommand(message.command));
        link.deliver({ type: "ack", commandId: message.commandId, version });
      } else {
        const { version, skipped } = await this.revert(projectId, message.type, message.commandId);
        link.deliver({ type: "ack", commandId: message.commandId, version, skipped });
      }
    } catch (error) {
      if (error instanceof ApiError) return reject(error.code, error.message);
      reject("internal", "Something went wrong");
    }
  }

  private historyOf(projectId: string) {
    let history = this.history.get(projectId);
    if (!history) {
      history = { undo: [], redo: [], changes: new Map() };
      this.history.set(projectId, history);
    }
    return history;
  }

  private apply(projectId: string, commandId: string, command: Command): Promise<number> {
    return this.serial(async () => {
      const project = this.mustProject(projectId);
      if (project.archived) throw conflict("This project is archived");
      const state = stateOf(project);
      this.checkAssignee(state, command);
      const result = applyCommand(state, this.engineCalendar(), command);
      if (!result.ok) throw new ApiError(422, result.reason, result.message);
      if (result.changes.length === 0) return project.version;
      const history = this.historyOf(projectId);
      history.undo.push(commandId);
      history.changes.set(commandId, result.changes);
      for (const dropped of history.undo.splice(0, Math.max(0, history.undo.length - 100))) history.changes.delete(dropped);
      for (const dropped of history.redo.splice(0)) history.changes.delete(dropped);
      return this.commit(project, result.state, commandId, result.changes);
    });
  }

  /** Undo/redo of this visit's own latest change (skip-on-conflict, like the server). */
  private revert(projectId: string, direction: "undo" | "redo", commandId: string): Promise<{ version: number; skipped: number }> {
    return this.serial(async () => {
      const project = this.mustProject(projectId);
      if (project.archived) throw conflict("This project is archived");
      const history = this.historyOf(projectId);
      const stack = history[direction];
      const target = stack.at(-1);
      if (!target) throw new ApiError(422, "invalid", direction === "undo" ? "Nothing to undo" : "Nothing to redo");
      const state = stateOf(project);
      const { state: next, skipped } = revertChanges(state, history.changes.get(target) ?? [], direction);
      // A change that can't apply any more is dropped from the history, so the next undo moves on.
      const discard = (error: ApiError) => {
        stack.pop();
        return error;
      };
      if (findTreeProblem(Object.values(next.rows)) || hasCycle(next, this.engineCalendar())) {
        throw discard(new ApiError(409, "conflict", `Can't ${direction} this any more: the board changed since`));
      }
      const changes = diffRows(state, next);
      if (changes.length === 0) throw discard(new ApiError(409, "conflict", `Nothing left to ${direction}: it was all changed since`));
      stack.pop();
      (direction === "undo" ? history.redo : history.undo).push(target);
      return { version: await this.commit(project, next, commandId, changes), skipped };
    });
  }

  /** New assignees must be existing, active team members (keeping the current one is always fine). */
  private checkAssignee(state: ProjectState, command: Command): void {
    if (command.type !== "setAssignee" || command.resourceId === null) return;
    const row = state.rows[command.id];
    if (row?.kind === "task" && row.resourceId === command.resourceId) return;
    const person = this.workspace.team.find((entry) => entry.id === command.resourceId);
    if (!person) throw new ApiError(422, "invalid", "That team member does not exist");
    if (person.inactive) throw new ApiError(422, "invalid", "That team member is inactive");
  }

  /** Keeps the new board state as the next version, saves it and sends the patch to its open boards. */
  private async commit(project: ProjectRecord, state: ProjectState, commandId: string, changes: RowChange[]): Promise<number> {
    project.rows = Object.values(state.rows);
    project.version++;
    await this.persist(() => this.store.saveProject(project));
    this.broadcast(project.id, { type: "patch", projectId: project.id, version: project.version, commandId, actor: { userId: null, label: "You" }, changes });
    return project.version;
  }

  protected now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  protected newId(): string {
    return (this.options.newId ?? randomId)();
  }

  /** One change at a time: request checks load asynchronously, and changes must not interleave. */
  protected serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.serialized.then(work, work);
    this.serialized = next.catch(() => undefined);
    return next;
  }

  /** Saves; a failure is reported, and the change stays in memory for this visit. */
  protected async persist(save: () => Promise<void>): Promise<void> {
    try {
      await save();
    } catch (error) {
      this.options.onStorageError?.(error);
    }
  }

  protected mustProject(id: string): ProjectRecord {
    const project = this.projects.get(id);
    if (!project) throw notFound("Project");
    return project;
  }

  /** The engine's calendar for the current team calendar (rebuilt after each change). */
  protected engineCalendar(): Calendar {
    this.calendarCache ??= buildCalendar(this.workspace);
    return this.calendarCache;
  }

  /**
   * Changes the team calendar on a copy, checks the result still makes a valid calendar, then
   * keeps it (a new version), saves it and tells every open board.
   */
  private async changeCalendar<T>(work: (draft: WorkspaceRecord) => T): Promise<T> {
    const draft = copy(this.workspace);
    const result = work(draft);
    draft.instanceVersion++;
    let calendar: Calendar;
    try {
      calendar = buildCalendar(draft);
    } catch (error) {
      throw badRequest((error as Error).message);
    }
    this.workspace = draft;
    this.calendarCache = calendar;
    await this.persist(() => this.store.saveWorkspace(draft));
    this.broadcast(null, { type: "instance", version: draft.instanceVersion });
    return result;
  }

  /** Sends to every link on `projectId` (or every link, for null). */
  protected broadcast(projectId: string | null, message: ServerMessage): void {
    for (const link of this.links) if (projectId === null || link.projectId === projectId) link.deliver(message);
  }
}

function buildCalendar(workspace: WorkspaceRecord): Calendar {
  const dto = toCalendarDto(workspace);
  return new Calendar({ workingWeekdays: dto.workingWeekdays, holidays: dto.holidays, timeOff: dto.timeOff });
}

function stateOf(project: ProjectRecord): ProjectState {
  return { rows: Object.fromEntries(project.rows.map((row) => [row.id, row])) };
}

function assertPeople(workspace: WorkspaceRecord, ids: "all" | readonly string[]): void {
  if (ids === "all") return;
  const known = new Set(workspace.team.map((person) => person.id));
  if (!ids.every((id) => known.has(id))) throw badRequest("Unknown team member");
}

function assertLocations(workspace: WorkspaceRecord, ids: readonly string[]): void {
  const known = new Set(workspace.locations.map((location) => location.id));
  if (!ids.every((id) => known.has(id))) throw badRequest("Unknown location");
}
