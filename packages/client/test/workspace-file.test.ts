import { describe, expect, it } from "vitest";
import { LocalSource } from "../src/local/local-source";
import { MemoryStore } from "../src/local/store";
import { MAX_FILE_BYTES, readWorkspaceFile } from "../src/local/workspace-file";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function filledSource() {
  const source = await LocalSource.open(new MemoryStore());
  const project = await source.createProject({ name: "Launch" });
  const ana = await source.createResource({ name: "Ana" });
  await source.saveTimeOff({ resourceId: ana.id, startDate: "2026-10-12", endDate: "2026-10-12", note: "" });
  const link = source.openBoard(project.id).openLink();
  await settle();
  link.send(JSON.stringify({ type: "join", projectId: project.id, version: 0 }));
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
      await expect(readWorkspaceFile(JSON.stringify({ ...file, version: 2 }))).rejects.toMatchObject({ code: "newer_version" });
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
      orphan.projects[0].rows[0].predecessorId = "99999999-9999-4999-8999-999999999999";
      await expect(readWorkspaceFile(JSON.stringify(orphan))).rejects.toMatchObject({ code: "invalid_file", message: expect.stringMatching(/predecessor/) });
    });

    it("with tasks that depend on each other in a loop", async () => {
      const file = await base();
      const first = file.projects[0].rows[0];
      const second = { ...first, id: B, position: "a1", predecessorId: first.id };
      first.predecessorId = B;
      file.projects[0].rows.push(second);
      await expect(readWorkspaceFile(JSON.stringify(file))).rejects.toMatchObject({ code: "invalid_file", message: expect.stringMatching(/loop/) });
    });
  });
});
