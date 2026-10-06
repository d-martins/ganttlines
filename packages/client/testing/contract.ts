import type { ClientMessage, ProjectDto, ServerMessage } from "@ganttlines/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import type { SocketLike, WorkspaceSource } from "../src/source";

type Message<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

/** A board's live link, with the messages it received (taken in any order with `next`). */
function listen(link: SocketLike) {
  const inbox: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  let opened!: () => void;
  const open = new Promise<void>((resolve) => (opened = resolve));
  link.onopen = () => opened();
  link.onmessage = (event) => {
    inbox.push(JSON.parse(String(event.data)) as ServerMessage);
    for (const wake of waiters.splice(0)) wake();
  };
  return {
    open,
    send: (message: ClientMessage) => link.send(JSON.stringify(message)),
    close: () => link.close(),
    async next<T extends ServerMessage["type"]>(type: T, where: (message: Message<T>) => boolean = () => true): Promise<Message<T>> {
      for (;;) {
        const index = inbox.findIndex((message) => message.type === type && where(message as Message<T>));
        if (index >= 0) return inbox.splice(index, 1)[0] as Message<T>;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
}

const TASK = "11111111-1111-4111-8111-111111111111";
const CREATE = "22222222-2222-4222-8222-222222222222";
const UNDO = "33333333-3333-4333-8333-333333333333";
const REDO = "55555555-5555-4555-8555-555555555555";
const AGAIN = "66666666-6666-4666-8666-666666666666";

/** A workspace with something of everything: a board with rows, a baseline, a location, time off, other working days. */
export async function fillWorkspace(source: WorkspaceSource): Promise<ProjectDto> {
  const project = await source.createProject({ name: "Launch" });
  const lisbon = await source.saveLocation({ name: "Lisbon", country: "PT" });
  const ana = await source.createResource({ name: "Ana" });
  await source.updateResource(ana.id, { locationId: lisbon.id });
  await source.saveTimeOff({ resourceId: ana.id, startDate: "2026-10-12", endDate: "2026-10-13", note: "away" });
  await source.setWorkingWeekdays([1, 2, 3, 4]);
  const link = source.openBoard(project.id).openLink();
  await new Promise((resolve) => setTimeout(resolve, 10));
  link.send(JSON.stringify({ type: "join", projectId: project.id, version: 0 }));
  link.send(JSON.stringify({ type: "command", commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", command: { type: "createRow", id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", kind: "task", parentId: null, afterId: null, title: "Design", start: "2026-10-05" } }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  await source.createBaseline(project.id, "Kick-off");
  await source.saveHighlight(project.id, { date: "2026-10-09", label: "Demo", color: "#e5892f" });
  link.close();
  return project;
}

/**
 * What every workspace source must do, whatever stores the data. `setup` gives a fresh, empty
 * workspace (apart from team members a source may start with).
 */
export function workspaceContract(setup: () => Promise<WorkspaceSource>): void {
  let source: WorkspaceSource;
  beforeEach(async () => {
    source = await setup();
  });

  /** A project with one task ("Design", from Oct 5), created over its live link. */
  async function projectWithTask() {
    const project = await source.createProject({ name: "Launch" });
    const board = source.openBoard(project.id);
    const live = listen(board.openLink());
    await live.open;
    live.send({ type: "join", projectId: project.id, version: 0 });
    await live.next("joined");
    live.send({
      type: "command",
      commandId: CREATE,
      command: { type: "createRow", id: TASK, kind: "task", parentId: null, afterId: null, title: "Design", start: "2026-10-05" },
    });
    await live.next("ack", (message) => message.commandId === CREATE);
    return { project, board, live };
  }

  describe("projects", () => {
    it("creates, renames, archives and deletes projects", async () => {
      expect(await source.listProjects()).toEqual([]);
      const project = await source.createProject({ name: "Launch" });
      expect(project).toMatchObject({ name: "Launch", archived: false, version: 0 });
      expect(await source.updateProject(project.id, { name: "Liftoff" })).toMatchObject({ id: project.id, name: "Liftoff" });
      await source.updateProject(project.id, { archived: true });
      expect(await source.listProjects()).toEqual([expect.objectContaining({ id: project.id, name: "Liftoff", archived: true })]);
      await source.deleteProject(project.id);
      expect(await source.listProjects()).toEqual([]);
    });

    it("only deletes archived projects", async () => {
      const project = await source.createProject({ name: "Launch" });
      await expect(source.deleteProject(project.id)).rejects.toMatchObject({ status: 409 });
    });
  });

  describe("boards", () => {
    it("loads a board, applies edits over its live link, and undoes them", async () => {
      const project = await source.createProject({ name: "Launch" });
      const board = source.openBoard(project.id);
      expect(await board.load()).toMatchObject({ project: { id: project.id, version: 0 }, rows: [] });
      const live = listen(board.openLink());
      await live.open;
      live.send({ type: "join", projectId: project.id, version: 0 });
      expect(await live.next("joined")).toMatchObject({ projectId: project.id, version: 0 });
      live.send({
        type: "command",
        commandId: CREATE,
        command: { type: "createRow", id: TASK, kind: "task", parentId: null, afterId: null, title: "Design", start: "2026-10-05" },
      });
      expect(await live.next("ack", (message) => message.commandId === CREATE)).toMatchObject({ version: 1 });
      expect(await live.next("patch")).toMatchObject({ version: 1, commandId: CREATE, changes: [expect.objectContaining({ rowId: TASK })] });
      expect((await board.load()).rows).toEqual([expect.objectContaining({ id: TASK, title: "Design" })]);
      live.send({ type: "undo", commandId: UNDO });
      expect(await live.next("ack", (message) => message.commandId === UNDO)).toMatchObject({ version: 2 });
      expect((await board.load()).rows).toEqual([]);
      live.close();
    });

    it("redoes an undone edit", async () => {
      const { board, live } = await projectWithTask();
      live.send({ type: "undo", commandId: UNDO });
      await live.next("ack", (message) => message.commandId === UNDO);
      live.send({ type: "redo", commandId: REDO });
      expect(await live.next("ack", (message) => message.commandId === REDO)).toMatchObject({ version: 3 });
      expect((await board.load()).rows).toEqual([expect.objectContaining({ id: TASK, title: "Design" })]);
      live.close();
    });

    it("rejects an edit that can't apply, and changes nothing", async () => {
      const { board, live } = await projectWithTask();
      live.send({
        type: "command",
        commandId: AGAIN,
        command: { type: "createRow", id: TASK, kind: "task", parentId: null, afterId: null, title: "Twice", start: "2026-10-05" },
      });
      expect(await live.next("reject", (message) => message.commandId === AGAIN)).toMatchObject({ message: expect.any(String) });
      expect(await board.load()).toMatchObject({ project: { version: 1 }, rows: [expect.objectContaining({ id: TASK, title: "Design" })] });
      live.close();
    });

    it("catches up a link that joins behind (missed edits, or a reload)", async () => {
      const { project, board, live } = await projectWithTask();
      const late = listen(board.openLink());
      await late.open;
      late.send({ type: "join", projectId: project.id, version: 0 });
      await late.next("joined");
      const caughtUp = await Promise.race([
        late.next("patch", (message) => message.version === 1).then((message) => message.type),
        late.next("reload").then((message) => message.type),
      ]);
      expect(["patch", "reload"]).toContain(caughtUp);
      late.close();
      live.close();
    });

    it("tells an open board when its highlights change", async () => {
      const { project, live } = await projectWithTask();
      const demo = await source.saveHighlight(project.id, { date: "2026-10-09", label: "Demo", color: "#e5892f" });
      expect(await live.next("highlights")).toMatchObject({ projectId: project.id, highlights: [expect.objectContaining({ id: demo.id })] });
      live.close();
    });

    it("says a board that doesn't exist can't be shown", async () => {
      const board = source.openBoard("44444444-4444-4444-8444-444444444444");
      const error = await board.load().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ status: 404 });
      expect(board.isFatal(error)).toBe(true);
    });
  });

  describe("highlights and baselines", () => {
    it("keeps a board's highlights", async () => {
      const project = await source.createProject({ name: "Launch" });
      const demo = await source.saveHighlight(project.id, { date: "2026-10-09", label: "Demo", color: "#e5892f" });
      expect(await source.highlights(project.id)).toEqual([demo]);
      expect(await source.saveHighlight(project.id, { date: "2026-10-10", label: "Demo", color: "#e5892f" }, demo.id)).toMatchObject({ id: demo.id, date: "2026-10-10" });
      await source.deleteHighlight(project.id, demo.id);
      expect(await source.highlights(project.id)).toEqual([]);
    });

    it("saves baselines of a board's dates", async () => {
      const { project, live } = await projectWithTask();
      const kickoff = await source.createBaseline(project.id, "Kick-off");
      expect(kickoff).toMatchObject({ name: "Kick-off" });
      expect(await source.baselines(project.id)).toEqual([kickoff]);
      expect(await source.baselineSnapshot(project.id, kickoff.id)).toMatchObject({
        baseline: { id: kickoff.id, name: "Kick-off" },
        tasks: [expect.objectContaining({ rowId: TASK, title: "Design", start: "2026-10-05" })],
      });
      await source.deleteBaseline(project.id, kickoff.id);
      expect(await source.baselines(project.id)).toEqual([]);
      live.close();
    });
  });

  describe("team calendar", () => {
    it("keeps team members, working weekdays, locations, holidays and time off", async () => {
      const before = await source.calendar();
      const ana = await source.createResource({ name: "Ana" });
      expect(await source.resources()).toContainEqual(expect.objectContaining({ id: ana.id, name: "Ana", inactive: false }));
      await source.setWorkingWeekdays([1, 2, 3, 4]);
      const lisbon = await source.saveLocation({ name: "Lisbon", country: "PT" });
      const fair = await source.saveHoliday({ name: "Fair", startDate: "2026-10-08", endDate: "2026-10-08", appliesTo: "all" });
      expect(await source.saveHoliday({ name: "Fair days", startDate: "2026-10-08", endDate: "2026-10-09", appliesTo: "all" }, fair.id)).toMatchObject({ id: fair.id, name: "Fair days" });
      const away = await source.saveTimeOff({ resourceId: ana.id, startDate: "2026-10-12", endDate: "2026-10-13", note: "" });
      expect(await source.updateResource(ana.id, { name: "Ana Silva", locationId: lisbon.id })).toMatchObject({ name: "Ana Silva", locationId: lisbon.id });

      const after = await source.calendar();
      expect(after.instanceVersion).toBeGreaterThan(before.instanceVersion);
      expect(after.workingWeekdays).toEqual([1, 2, 3, 4]);
      expect(after.locations).toContainEqual(expect.objectContaining({ id: lisbon.id, name: "Lisbon", country: "PT" }));
      expect(after.holidays).toContainEqual(expect.objectContaining({ id: fair.id, name: "Fair days", endDate: "2026-10-09" }));
      expect(after.timeOff).toContainEqual(expect.objectContaining({ id: away.id, resourceId: ana.id }));

      await source.deleteTimeOff(away.id);
      await source.deleteHoliday(fair.id);
      await source.updateResource(ana.id, { locationId: null });
      await source.deleteLocation(lisbon.id);
      const cleared = await source.calendar();
      expect(cleared.timeOff.map((entry) => entry.id)).not.toContain(away.id);
      expect(cleared.holidays.map((entry) => entry.id)).not.toContain(fair.id);
      expect(cleared.locations.map((entry) => entry.id)).not.toContain(lisbon.id);
    });

    it("looks up and adds a country's public holidays", async () => {
      expect(await source.holidayCountries()).toContainEqual({ code: "PT", name: expect.any(String) });
      expect((await source.holidayRegions("DE")).length).toBeGreaterThan(0);
      const lisbon = await source.saveLocation({ name: "Lisbon", country: "PT" });
      const suggested = await source.locationPublicHolidays(lisbon.id, 2026);
      expect(suggested.length).toBeGreaterThan(0);
      const first = suggested[0]!;
      expect(first).toMatchObject({ startDate: expect.stringMatching(/^2026-/), added: false });
      expect(await source.importHolidays(lisbon.id, [{ name: first.name, startDate: first.startDate, endDate: first.endDate }])).toBe(1);
      expect((await source.locationPublicHolidays(lisbon.id, 2026))[0]).toMatchObject({ added: true });
    });
  });
}
