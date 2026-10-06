import { describe, expect, it } from "vitest";
import { checkFormat, emptyWorkspace, toCalendarDto } from "../src/local/records";
import { MemoryStore } from "../src/local/store";
import { validation } from "../src/local/validation";
import { fillWorkspace, workspaceContract } from "../testing/contract";
import { LocalSource } from "../src/local/local-source";
import type { ServerMessage } from "@ganttlines/protocol";

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

const contents = (source: LocalSource) => ({ ...source.exportFile(), exportedAt: "" });

describe("local workspace storage", () => {
  it("gives back everything — rows, baselines, calendar — when reopened", async () => {
    const store = new MemoryStore();
    const first = await LocalSource.open(store);
    await fillWorkspace(first);
    expect(contents(first).projects[0]?.rows).toHaveLength(1);
    expect(contents(await LocalSource.open(store))).toEqual(contents(first));
  });

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
    expect(source.exportFile().projects).toEqual([expect.objectContaining({ id: project.id })]);
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

const TASK = "11111111-1111-4111-8111-111111111111";
const createDesign = (commandId: string) =>
  JSON.stringify({ type: "command", commandId, command: { type: "createRow", id: TASK, kind: "task", parentId: null, afterId: null, title: "Design", start: "2026-10-05" } });
/** Collects what a link receives; resolves once `count` messages arrived. */
function inbox(link: { onmessage: ((event: { data: unknown }) => void) | null }) {
  const messages: ServerMessage[] = [];
  link.onmessage = (event) => messages.push(JSON.parse(String(event.data)) as ServerMessage);
  return messages;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("local boards", () => {
  it("sends each change to every open board of the project, and the answer only to the sender", async () => {
    const source = await LocalSource.open(new MemoryStore());
    const project = await source.createProject({ name: "Launch" });
    const board = source.openBoard(project.id);
    const [a, b] = [board.openLink(), board.openLink()];
    const [toA, toB] = [inbox(a), inbox(b)];
    await settle();
    for (const link of [a, b]) link.send(JSON.stringify({ type: "join", projectId: project.id, version: 0 }));
    await settle();
    a.send(createDesign("22222222-2222-4222-8222-222222222222"));
    await settle();
    expect(toA.map((message) => message.type)).toEqual(["joined", "patch", "ack"]);
    expect(toB.map((message) => message.type)).toEqual(["joined", "patch"]);
  });

  it("starts each visit with an empty undo history", async () => {
    const store = new MemoryStore();
    const first = await LocalSource.open(store);
    const project = await first.createProject({ name: "Launch" });
    const link = first.openBoard(project.id).openLink();
    await settle();
    link.send(JSON.stringify({ type: "join", projectId: project.id, version: 0 }));
    link.send(createDesign("22222222-2222-4222-8222-222222222222"));
    await settle();
    const again = await LocalSource.open(store);
    const later = again.openBoard(project.id).openLink();
    const received = inbox(later);
    await settle();
    later.send(JSON.stringify({ type: "join", projectId: project.id, version: 1 }));
    later.send(JSON.stringify({ type: "undo", commandId: "33333333-3333-4333-8333-333333333333" }));
    await settle();
    expect(received).toContainEqual(expect.objectContaining({ type: "reject", message: "Nothing to undo" }));
    expect((await again.openBoard(project.id).load()).rows).toEqual([expect.objectContaining({ id: TASK })]);
  });

  it("ends a deleted project's open boards", async () => {
    const source = await LocalSource.open(new MemoryStore());
    const project = await source.createProject({ name: "Launch" });
    const link = source.openBoard(project.id).openLink();
    const closed = new Promise<number>((resolve) => (link.onclose = (event) => resolve(event.code)));
    await settle();
    link.send(JSON.stringify({ type: "join", projectId: project.id, version: 0 }));
    await settle();
    await source.updateProject(project.id, { archived: true });
    await source.deleteProject(project.id);
    expect(await closed).toBe(4004);
  });
});
