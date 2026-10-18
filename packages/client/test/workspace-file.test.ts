import { Calendar, computeSchedule, fromDay, linkKey } from "@ganttlines/engine";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@ganttlines/protocol";
import { LocalSource } from "../src/local/local-source";
import { MemoryStore } from "../src/local/store";
import { MAX_FILE_BYTES, readWorkspaceFile } from "../src/local/workspace-file";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";
const E = "55555555-5555-4555-8555-555555555555";
const P = "66666666-6666-4666-8666-666666666666";
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function filledSource() {
  const source = await LocalSource.open(new MemoryStore());
  const project = await source.createProject({ name: "Launch" });
  const ana = await source.createResource({ name: "Ana" });
  await source.saveTimeOff({ resourceId: ana.id, startDate: "2026-10-12", endDate: "2026-10-12", note: "" });
  const link = source.openBoard(project.id).openLink();
  await settle();
  link.send(JSON.stringify({ type: "join", projectId: project.id, version: 0, protocol: PROTOCOL_VERSION }));
  link.send(JSON.stringify({ type: "command", commandId: B, command: { type: "createRow", id: A, kind: "task", parentId: null, afterId: null, title: "Design", start: "2026-10-05" } }));
  await settle();
  await source.saveHighlight(project.id, { date: "2026-10-09", label: "Demo", color: "#e5892f" });
  await source.createBaseline(project.id, "Kick-off");
  return { source, project };
}

describe("the workspace file", () => {
  it("exports a workspace that imports into another browser as the same workspace", async () => {
    const { source, project } = await filledSource();
    const file = await readWorkspaceFile(JSON.stringify(source.exportFile()));
    const elsewhere = await LocalSource.open(new MemoryStore());
    await elsewhere.replaceWith(file);
    expect(await elsewhere.listProjects()).toEqual(await source.listProjects());
    expect((await elsewhere.calendar()).timeOff).toEqual((await source.calendar()).timeOff);
    expect(await elsewhere.resources()).toEqual(await source.resources());
    expect(await elsewhere.openBoard(project.id).load()).toEqual(await source.openBoard(project.id).load());
    expect(await elsewhere.highlights(project.id)).toEqual(await source.highlights(project.id));
    expect(await elsewhere.baselines(project.id)).toEqual(await source.baselines(project.id));
  });

  it("imports again whatever the app let you make (long names, deep order keys, late baseline dates)", async () => {
    const { source, project } = await filledSource();
    await source.updateProject(project.id, { name: "x".repeat(200) });
    const file = JSON.parse(JSON.stringify(source.exportFile())) as Record<string, any>;
    file.projects[0].rows[0].position = "a".repeat(5_000);
    file.projects[0].baselines[0].tasks[0].end = "2205-01-01";
    await expect(readWorkspaceFile(JSON.stringify(file))).resolves.toMatchObject({ projects: [expect.objectContaining({ name: "x".repeat(200) })] });
  });

  it("export writes version 2 with links", async () => {
    const { source, project } = await filledSource();
    const link = source.openBoard(project.id).openLink();
    await settle();
    link.send(JSON.stringify({ type: "join", projectId: project.id, version: 1, protocol: PROTOCOL_VERSION }));
    link.send(JSON.stringify({ type: "command", commandId: C, command: { type: "createRow", id: D, kind: "task", parentId: null, afterId: A, title: "Build", start: "2026-10-12" } }));
    link.send(JSON.stringify({ type: "command", commandId: E, command: { type: "addLink", predecessorId: A, followerId: D, kind: "SS", lag: 1 } }));
    await settle();
    const file = source.exportFile();
    expect(file.version).toBe(2);
    expect(file.projects[0]?.links).toEqual([{ predecessorId: A, followerId: D, kind: "SS", lag: 1 }]);
    for (const row of file.projects[0]!.rows) expect(row).not.toHaveProperty("predecessorId");
    expect((await readWorkspaceFile(JSON.stringify(file))).projects[0]?.links).toEqual(file.projects[0]?.links);
  });

  it("importing a v1 file with a chain and negative offsets gives the same dates", async () => {
    // A → B (1 day overlap) → C (1.5 days overlap) → D (2 days later); E names a task that isn't there.
    const ids = { a: A, b: B, c: C, d: D, e: E };
    const row = (key: keyof typeof ids, userStart: string, duration: number, predecessor: keyof typeof ids | null, offset: number) => ({
      id: ids[key], kind: "task", title: key, parentId: null, position: `a${Object.keys(ids).indexOf(key)}`, userStart, startsAfternoon: false, duration, actualDuration: null,
      resourceId: null, color: "blue", locked: false, description: "", predecessorId: predecessor ? ids[predecessor] : null, offset,
    });
    const rows = [row("a", "2026-10-05", 3, null, 0), row("b", "2026-10-01", 2, "a", -1), row("c", "2026-10-01", 2.5, "b", -1.5), row("d", "2026-10-01", 1, "c", 2), row("e", "2026-10-20", 1, null, 0)];
    rows[4]!.predecessorId = "99999999-9999-4999-8999-999999999999";
    const v1 = {
      format: "ganttlines-workspace", version: 1, exportedAt: "2026-10-01T00:00:00.000Z", workingWeekdays: [1, 2, 3, 4, 5], team: [], locations: [], holidays: [], timeOff: [],
      projects: [{ id: P, name: "Launch", archived: false, createdAt: "2026-10-01T00:00:00.000Z", version: 4, rows, highlights: [], baselines: [] }],
    };
    // The dates the previous version of GanttLines scheduled for these rows.
    const before = {
      a: ["2026-10-05", false, "2026-10-07", false],
      b: ["2026-10-07", false, "2026-10-08", false],
      c: ["2026-10-08", false, "2026-10-12", true],
      d: ["2026-10-14", true, "2026-10-15", true],
      e: ["2026-10-20", false, "2026-10-20", false],
    };
    const file = await readWorkspaceFile(JSON.stringify(v1));
    expect(file.version).toBe(2);
    const source = await LocalSource.open(new MemoryStore());
    await source.replaceWith(file);
    const board = await source.openBoard(P).load();
    expect(board.links).toHaveLength(3);
    const state = { rows: Object.fromEntries(board.rows.map((entry) => [entry.id, entry])), links: Object.fromEntries(board.links.map((entry) => [linkKey(entry), entry])) };
    const schedule = computeSchedule(state, new Calendar({ workingWeekdays: [1, 2, 3, 4, 5], holidays: [], timeOff: [] }));
    const after = Object.fromEntries(
      Object.entries(ids).map(([key, id]) => {
        const span = schedule.get(id)!.span!;
        return [key, [fromDay(span.start), span.startsAfternoon, fromDay(span.end), span.endsMidday]];
      }),
    );
    expect(after).toEqual(before);
  });

  it("clears the workspace", async () => {
    const { source } = await filledSource();
    await source.clear();
    expect(await source.listProjects()).toEqual([]);
    expect(await source.resources()).toEqual([]);
  });

  describe("refuses files it can't trust, with a reason", () => {
    const base = async () => JSON.parse(JSON.stringify((await filledSource()).source.exportFile())) as Record<string, any>;

    it("not JSON, or not a workspace", async () => {
      await expect(readWorkspaceFile("not json")).rejects.toMatchObject({ code: "invalid_file" });
      await expect(readWorkspaceFile(JSON.stringify({ format: "excalidraw" }))).rejects.toMatchObject({ code: "invalid_file" });
    });

    it("from a newer GanttLines", async () => {
      const file = await base();
      await expect(readWorkspaceFile(JSON.stringify({ ...file, version: 3 }))).rejects.toMatchObject({ code: "newer_version" });
    });

    it("too big", async () => {
      await expect(readWorkspaceFile(" ".repeat(MAX_FILE_BYTES + 1))).rejects.toMatchObject({ code: "invalid_file", message: expect.stringMatching(/50 MB/) });
    });

    it("with fields that don't fit", async () => {
      const file = await base();
      file.projects[0].rows[0].duration = -3;
      await expect(readWorkspaceFile(JSON.stringify(file))).rejects.toMatchObject({ code: "invalid_file" });
    });

    it("pointing at people or rows that aren't there", async () => {
      const ghost = await base();
      ghost.projects[0].rows[0].resourceId = "99999999-9999-4999-8999-999999999999";
      await expect(readWorkspaceFile(JSON.stringify(ghost))).rejects.toMatchObject({ code: "invalid_file", message: expect.stringMatching(/team member/) });
      const orphan = await base();
      orphan.projects[0].links.push({ predecessorId: "99999999-9999-4999-8999-999999999999", followerId: A, kind: "FS", lag: 0 });
      await expect(readWorkspaceFile(JSON.stringify(orphan))).rejects.toMatchObject({ code: "invalid_file", message: expect.stringMatching(/missing task/) });
    });

    it("with calendar entries the app would never accept", async () => {
      const reversed = await base();
      reversed.timeOff[0].endDate = "2026-10-01";
      await expect(readWorkspaceFile(JSON.stringify(reversed))).rejects.toMatchObject({ code: "invalid_file" });
      const endless = await base();
      Object.assign(endless.timeOff[0], { startDate: "1970-01-01", endDate: "2199-12-31" });
      await expect(readWorkspaceFile(JSON.stringify(endless))).rejects.toMatchObject({ code: "invalid_file", message: expect.stringMatching(/366/) });
      const nobody = await base();
      nobody.holidays.push({ id: "88888888-8888-4888-8888-888888888888", name: "Nobody", startDate: "2026-12-24", endDate: "2026-12-24", appliesToAll: false, resourceIds: [], locationIds: [] });
      await expect(readWorkspaceFile(JSON.stringify(nobody))).rejects.toMatchObject({ code: "invalid_file" });
      const both = await base();
      both.holidays.push({ id: "88888888-8888-4888-8888-888888888888", name: "Both", startDate: "2026-12-24", endDate: "2026-12-24", appliesToAll: true, resourceIds: [both.team[0].id], locationIds: [] });
      await expect(readWorkspaceFile(JSON.stringify(both))).rejects.toMatchObject({ code: "invalid_file" });
      const twice = await base();
      twice.workingWeekdays = [1, 1, 2];
      await expect(readWorkspaceFile(JSON.stringify(twice))).rejects.toMatchObject({ code: "invalid_file" });
    });

    it("with links the app would never make", async () => {
      const file = await base();
      file.projects[0].rows.push({ ...file.projects[0].rows[0], id: B, position: "a1" });
      file.projects[0].links.push({ predecessorId: A, followerId: B, kind: "SS", lag: -1 });
      await expect(readWorkspaceFile(JSON.stringify(file))).rejects.toMatchObject({ code: "invalid_file", message: expect.stringMatching(/lag/) });
      const twice = await base();
      twice.projects[0].rows.push({ ...twice.projects[0].rows[0], id: B, position: "a1" });
      twice.projects[0].links.push({ predecessorId: A, followerId: B, kind: "FS", lag: 0 }, { predecessorId: A, followerId: B, kind: "FS", lag: 1 });
      await expect(readWorkspaceFile(JSON.stringify(twice))).rejects.toMatchObject({ code: "invalid_file", message: expect.stringMatching(/twice/) });
    });

    it("with the same id twice", async () => {
      const projects = await base();
      projects.projects.push({ ...projects.projects[0], name: "Copy" });
      await expect(readWorkspaceFile(JSON.stringify(projects))).rejects.toMatchObject({ code: "invalid_file", message: expect.stringMatching(/twice/) });
      const rows = await base();
      rows.projects[0].rows.push({ ...rows.projects[0].rows[0], title: "Again" });
      await expect(readWorkspaceFile(JSON.stringify(rows))).rejects.toMatchObject({ code: "invalid_file", message: expect.stringMatching(/twice/) });
      const people = await base();
      people.team.push({ ...people.team[0], name: "Clone" });
      await expect(readWorkspaceFile(JSON.stringify(people))).rejects.toMatchObject({ code: "invalid_file", message: expect.stringMatching(/twice/) });
    });

    it("whose calendar would take too long to work out (many long holidays for many people)", async () => {
      const file = await base();
      const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");
      file.team = Array.from({ length: 1000 }, (_, i) => ({ id: `00000000-0000-4000-8000-${hex(i, 12)}`, name: `P${i}`, avatarColor: "#4f8cff", inactive: false, locationId: null }));
      const everyone = file.team.map((person: { id: string }) => person.id);
      file.timeOff = [];
      file.projects[0].rows[0].resourceId = null;
      file.holidays = Array.from({ length: 200 }, (_, i) => ({ id: `00000000-0000-4000-9000-${hex(i, 12)}`, name: `H${i}`, startDate: "2026-01-01", endDate: "2026-12-31", appliesToAll: false, resourceIds: everyone, locationIds: [] }));
      const started = Date.now();
      await expect(readWorkspaceFile(JSON.stringify(file))).rejects.toMatchObject({ code: "invalid_file", message: expect.stringMatching(/too large/) });
      expect(Date.now() - started).toBeLessThan(3000);
    });

    it("with tasks that depend on each other in a loop", async () => {
      const file = await base();
      const first = file.projects[0].rows[0];
      file.projects[0].rows.push({ ...first, id: B, position: "a1" });
      file.projects[0].links.push({ predecessorId: first.id, followerId: B, kind: "FS", lag: 0 }, { predecessorId: B, followerId: first.id, kind: "SS", lag: 0 });
      await expect(readWorkspaceFile(JSON.stringify(file))).rejects.toMatchObject({ code: "invalid_file", message: expect.stringMatching(/loop/) });
    });
  });
});
