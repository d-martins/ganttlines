import { describe, expect, it } from "vitest";
import { emptyWorkspace, type ProjectRecord } from "../src/local/records";
import { upgradeProjectRecord, upgradeWorkspaceRecord } from "../src/local/upgrade";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const GHOST = "99999999-9999-4999-8999-999999999999";

const task = (id: string, predecessorId: string | null, offset: number) => ({
  id,
  kind: "task",
  title: id,
  parentId: null,
  position: `a${id[0]}`,
  userStart: "2026-10-05",
  startsAfternoon: false,
  duration: 1,
  actualDuration: null,
  resourceId: null,
  color: "blue",
  locked: false,
  description: "",
  predecessorId,
  offset,
});
const v1Project = (rows: unknown[]) => ({ id: "p", name: "Launch", archived: false, createdAt: "2026-10-01T00:00:00.000Z", version: 3, rows, highlights: [], baselines: [] });

describe("upgrading local records", () => {
  it("upgradeProjectRecord turns predecessorId/offset into FS links and drops the fields", () => {
    const v1 = v1Project([task(A, null, 0), task(B, A, -1.5), task(C, B, 2)]);
    const upgraded = upgradeProjectRecord(v1);
    expect(v1.rows[1]).toMatchObject({ predecessorId: A, offset: -1.5 });
    expect(upgraded.links).toEqual([
      { predecessorId: A, followerId: B, kind: "FS", lag: -1.5 },
      { predecessorId: B, followerId: C, kind: "FS", lag: 2 },
    ]);
    for (const row of upgraded.rows) {
      expect(row).not.toHaveProperty("predecessorId");
      expect(row).not.toHaveProperty("offset");
    }
    expect(upgraded).toMatchObject({ id: "p", name: "Launch", version: 3, highlights: [], baselines: [] });
  });

  it("it drops a dangling predecessor", () => {
    const upgraded = upgradeProjectRecord(v1Project([task(A, GHOST, 1), task(B, B, 0), { id: C, kind: "section", title: "S", parentId: null, position: "a2" }]));
    expect(upgraded.links).toEqual([]);
    expect(upgraded.rows).toHaveLength(3);
    expect(upgraded.rows[0]).not.toHaveProperty("predecessorId");
  });

  it("it leaves an upgraded record alone", () => {
    const v2: ProjectRecord = upgradeProjectRecord(v1Project([task(A, null, 0), task(B, A, 0)]));
    const before = structuredClone(v2);
    expect(upgradeProjectRecord(v2)).toEqual(before);
    expect(v2).toEqual(before);
    const workspace = emptyWorkspace();
    expect(upgradeWorkspaceRecord(workspace)).toEqual(workspace);
    expect(upgradeWorkspaceRecord({ ...workspace, version: 1 })).toEqual(workspace);
  });

  it("a v1 record also gains tags and section descriptions", () => {
    const upgraded = upgradeProjectRecord(v1Project([task(A, null, 0), { id: C, kind: "section", title: "S", parentId: null, position: "a2" }]));
    expect(upgraded.rows[0]).toMatchObject({ tags: [] });
    expect(upgraded.rows[1]).toEqual({ id: C, kind: "section", title: "S", parentId: null, position: "a2", description: "" });
  });

  it("a v2 record gains empty tags on tasks and an empty description on sections", () => {
    const { predecessorId: _p, offset: _o, ...v2Task } = task(A, null, 0);
    const v2 = { ...v1Project([v2Task, { id: C, kind: "section", title: "S", parentId: null, position: "a2" }]), links: [] };
    const before = structuredClone(v2);
    const upgraded = upgradeProjectRecord(v2);
    expect(upgraded.rows).toEqual([{ ...v2Task, tags: [] }, { id: C, kind: "section", title: "S", parentId: null, position: "a2", description: "" }]);
    expect(upgraded).toMatchObject({ id: "p", version: 3, links: [], highlights: [], baselines: [] });
    expect(v2).toEqual(before);
    const workspace = emptyWorkspace();
    expect(upgradeWorkspaceRecord({ ...workspace, version: 2 })).toEqual(workspace);
    expect(workspace.version).toBe(3);
  });

  it("a v3 record is unchanged", () => {
    const { predecessorId: _p, offset: _o, ...v2Task } = task(A, null, 0);
    const v3 = { ...v1Project([{ ...v2Task, tags: ["UI"] }, { id: C, kind: "section", title: "S", parentId: null, position: "a2", description: "Notes" }]), links: [] };
    const before = structuredClone(v3);
    expect(upgradeProjectRecord(v3)).toBe(v3);
    expect(v3).toEqual(before);
  });

  it("it leaves a malformed record unchanged instead of throwing", () => {
    const noRows = { id: "p", name: "Launch" };
    expect(upgradeProjectRecord(noRows)).toBe(noRows);
    expect(upgradeProjectRecord(null)).toBeNull();
  });
});
