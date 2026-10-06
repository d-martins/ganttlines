import { describe, expect, it } from "vitest";
import { checkFormat, emptyWorkspace, toCalendarDto } from "../src/local/records";
import { MemoryStore } from "../src/local/store";
import { validation } from "../src/local/validation";
import { workspaceContract } from "../testing/contract";
import { LocalSource } from "../src/local/local-source";

describe("local records", () => {
  it("starts empty, with Monday–Friday working days", async () => {
    expect(await new MemoryStore().load()).toEqual({ workspace: null, projects: [] });
    expect(toCalendarDto(emptyWorkspace())).toEqual({ instanceVersion: 1, workingWeekdays: [1, 2, 3, 4, 5], holidays: [], timeOff: [], locations: [] });
  });

  it("keeps copies, so later changes to an object don't leak into the store", async () => {
    const store = new MemoryStore();
    const workspace = emptyWorkspace();
    await store.saveWorkspace(workspace);
    workspace.workingWeekdays.push(6);
    expect((await store.load()).workspace?.workingWeekdays).toEqual([1, 2, 3, 4, 5]);
  });

  it("refuses other formats and newer versions", () => {
    expect(() => checkFormat({ format: "something-else", version: 1 })).toThrow(expect.objectContaining({ status: 400, code: "invalid_file" }));
    expect(() => checkFormat({ format: "ganttlines-workspace", version: 99 })).toThrow(expect.objectContaining({ status: 400, code: "newer_version" }));
    expect(() => checkFormat({ format: "ganttlines-workspace", version: 1 })).not.toThrow();
  });

  it("resolves a location holiday to the people in that location", () => {
    const workspace = emptyWorkspace();
    workspace.locations.push({ id: "l1", name: "Lisbon", country: null, region: null });
    workspace.team.push({ id: "r1", name: "Ana", avatarColor: "#4f8cff", inactive: false, locationId: "l1" });
    workspace.holidays.push({ id: "h1", name: "Fair", startDate: "2026-10-08", endDate: "2026-10-08", appliesToAll: false, resourceIds: [], locationIds: ["l1"] });
    expect(toCalendarDto(workspace).holidays).toEqual([
      { id: "h1", name: "Fair", startDate: "2026-10-08", endDate: "2026-10-08", appliesTo: ["r1"], target: { all: false, resourceIds: [], locationIds: ["l1"] } },
    ]);
  });

  it("checks request bodies with the protocol's schemas (loaded on demand)", async () => {
    const { protocol, check } = await validation();
    expect(check(protocol.CreateProjectBody, { name: "  Launch  " })).toEqual({ name: "Launch" });
    expect(() => check(protocol.CreateProjectBody, { name: "" })).toThrow(expect.objectContaining({ status: 400, code: "invalid_request" }));
  });
});

describe("the browser as a workspace source", () => {
  workspaceContract(async () => LocalSource.open(new MemoryStore()));
});

describe("local workspace storage", () => {
  it("keeps everything for the next visit", async () => {
    const store = new MemoryStore();
    const first = await LocalSource.open(store);
    const project = await first.createProject({ name: "Launch" });
    const ana = await first.createResource({ name: "Ana" });
    await first.saveHoliday({ name: "Fair", startDate: "2026-10-08", endDate: "2026-10-08", appliesTo: [ana.id] });
    await first.saveHighlight(project.id, { date: "2026-10-09", label: "Demo", color: "#e5892f" });
    const again = await LocalSource.open(store);
    expect(await again.listProjects()).toEqual(await first.listProjects());
    expect(await again.calendar()).toEqual(await first.calendar());
    expect(await again.resources()).toEqual(await first.resources());
    expect(await again.highlights(project.id)).toEqual(await first.highlights(project.id));
  });

  it("keeps working in memory when a change can't be saved, and says so", async () => {
    class FullStore extends MemoryStore {
      override async saveProject(): Promise<void> {
        throw new Error("QuotaExceededError");
      }
    }
    const errors: unknown[] = [];
    const source = await LocalSource.open(new FullStore(), { onStorageError: (error) => errors.push(error) });
    const project = await source.createProject({ name: "Launch" });
    expect(await source.listProjects()).toEqual([expect.objectContaining({ id: project.id })]);
    expect(errors).toHaveLength(1);
  });

  it("gives team members the next color in turn, and checks requests like the server", async () => {
    const source = await LocalSource.open(new MemoryStore());
    const colors = await Promise.all(["A", "B"].map(async (name) => (await source.createResource({ name })).avatarColor));
    expect(colors).toEqual(["#4f8cff", "#a66cff"]);
    await expect(source.createProject({ name: "" })).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await expect(source.updateResource("77777777-7777-4777-8777-777777777777", { name: "X" })).rejects.toMatchObject({ status: 404, message: "Team member not found" });
    await expect(source.setWorkingWeekdays([])).rejects.toMatchObject({ status: 400 });
  });
});
