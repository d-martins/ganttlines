import { describe, expect, it } from "vitest";
import { WorkspaceFile, WorkspaceFileV1 } from "../src/workspace-file";

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

describe("WorkspaceFile", () => {
  it("accepts v2 with links and refuses a task row carrying predecessorId", () => {
    const link = { predecessorId: A, followerId: B, kind: "SS", lag: 1.5 };
    expect(WorkspaceFile.safeParse(file(2, [taskRow(A), taskRow(B)], [link])).success).toBe(true);
    expect(WorkspaceFile.safeParse(file(2, [taskRow(A), taskRow(B, { predecessorId: A })], [])).success).toBe(false);
    expect(WorkspaceFile.safeParse(file(2, [taskRow(A)], [{ ...link, kind: "SF" }])).success).toBe(false);
    expect(WorkspaceFile.safeParse(file(2, [taskRow(A)])).success).toBe(false);
    expect(WorkspaceFile.safeParse(file(1, [taskRow(A)], [])).success).toBe(false);
  });
});

describe("WorkspaceFileV1", () => {
  it("still accepts a v1 file", () => {
    const rows = [taskRow(A, { predecessorId: null, offset: 0 }), taskRow(B, { predecessorId: A, offset: -1.5 })];
    expect(WorkspaceFileV1.safeParse(file(1, rows)).success).toBe(true);
    expect(WorkspaceFileV1.safeParse(file(1, [taskRow(A)])).success).toBe(false);
  });
});
