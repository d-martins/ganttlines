import { describe, expect, it } from "vitest";
import { WorkspaceFile, WorkspaceFileV1, WorkspaceFileV2 } from "../src/workspace-file";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

const taskRow = (rowId: string, extra: object = {}) => ({
  id: rowId,
  kind: "task",
  title: "T",
  parentId: null,
  position: "a0",
  userStart: "2026-10-05",
  startsAfternoon: false,
  duration: 2,
  actualDuration: null,
  resourceId: null,
  color: "green",
  locked: false,
  description: "",
  ...extra,
});

const file = (version: number, rows: object[], links?: object[]) => ({
  format: "ganttlines-workspace",
  version,
  exportedAt: "2026-10-18T00:00:00Z",
  workingWeekdays: [1, 2, 3, 4, 5],
  team: [],
  locations: [],
  holidays: [],
  timeOff: [],
  projects: [{ id: C, name: "P", archived: false, createdAt: "2026-10-18T00:00:00Z", version: 3, rows, ...(links ? { links } : {}), highlights: [], baselines: [] }],
});

describe("WorkspaceFileV2", () => {
  it("accepts v2 with links and refuses a task row carrying predecessorId", () => {
    const link = { predecessorId: A, followerId: B, kind: "SS", lag: 1.5 };
    expect(WorkspaceFileV2.safeParse(file(2, [taskRow(A), taskRow(B)], [link])).success).toBe(true);
    expect(WorkspaceFileV2.safeParse(file(2, [taskRow(A), taskRow(B, { predecessorId: A })], [])).success).toBe(false);
    expect(WorkspaceFileV2.safeParse(file(2, [taskRow(A), taskRow(B)], [{ ...link, kind: "SF" }])).success).toBe(true);
    expect(WorkspaceFileV2.safeParse(file(2, [taskRow(A)], [{ ...link, kind: "XX" }])).success).toBe(false);
    expect(WorkspaceFileV2.safeParse(file(2, [taskRow(A)])).success).toBe(false);
    expect(WorkspaceFileV2.safeParse(file(1, [taskRow(A)], [])).success).toBe(false);
  });

  it("leaves duplicate links and links to missing tasks to the import, which refuses them", () => {
    const link = { predecessorId: A, followerId: B, kind: "FS", lag: 0 };
    expect(WorkspaceFileV2.safeParse(file(2, [taskRow(A), taskRow(B)], [link, { ...link, lag: 1 }])).success).toBe(true);
    expect(WorkspaceFileV2.safeParse(file(2, [taskRow(A)], [link])).success).toBe(true);
  });
});

describe("WorkspaceFile", () => {
  const section = (rowId: string, extra: object = {}) => ({ id: rowId, kind: "section", title: "S", parentId: null, position: "a1", ...extra });

  it("is version 3: tasks have tags, sections have a description", () => {
    expect(WorkspaceFile.safeParse(file(3, [taskRow(A, { tags: ["UI", "Back end"] }), section(B, { description: "Notes" })], [])).success).toBe(true);
    expect(WorkspaceFile.safeParse(file(3, [taskRow(A)], [])).success).toBe(false);
    expect(WorkspaceFile.safeParse(file(3, [taskRow(A, { tags: [] }), section(B)], [])).success).toBe(false);
    expect(WorkspaceFile.safeParse(file(3, [section(B, { description: "", tags: [] })], [])).success).toBe(false);
    expect(WorkspaceFile.safeParse(file(2, [taskRow(A, { tags: [] })], [])).success).toBe(false);
    expect(WorkspaceFileV2.safeParse(file(2, [taskRow(A, { tags: [] })], [])).success).toBe(false);
    expect(WorkspaceFileV2.safeParse(file(2, [section(B, { description: "" })], [])).success).toBe(false);
  });

  it("refuses tags the app would never store", () => {
    const withTags = (tags: string[]) => WorkspaceFile.safeParse(file(3, [taskRow(A, { tags })], [])).success;
    expect(withTags(["Q4 · must-have", "x".repeat(100)])).toBe(true);
    for (const tags of [[""], [" UI"], ["UI", "ui"], ["x".repeat(101)], Array.from({ length: 51 }, (_, i) => `t${i}`)]) expect(withTags(tags), String(tags[0])).toBe(false);
  });
});

describe("WorkspaceFileV1", () => {
  it("still accepts a v1 file", () => {
    const rows = [taskRow(A, { predecessorId: null, offset: 0 }), taskRow(B, { predecessorId: A, offset: -1.5 })];
    expect(WorkspaceFileV1.safeParse(file(1, rows)).success).toBe(true);
    expect(WorkspaceFileV1.safeParse(file(1, [taskRow(A)])).success).toBe(false);
  });
});
