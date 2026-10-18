import { describe, expect, it } from "vitest";
import { applyChanges, changedRowIds, diffState } from "../src/changes";
import { linkKey, type Link } from "../src/links";
import type { ProjectState } from "../src/model";
import { link, project, section, task } from "./fixtures";

describe("diffState / applyChanges", () => {
  const before = project(task("a", { userStart: "2026-10-05" }), section("s"));

  it("reports nothing for identical states", () => {
    expect(diffState(before, before)).toEqual([]);
  });

  it("reports changed fields, created rows and deleted rows in row-id order", () => {
    const after = {
      rows: {
        a: { ...before.rows.a!, title: "A2" },
        b: task("b", { position: "a5" }),
      },
      links: {},
    };
    expect(diffState(before, after)).toEqual([
      { rowId: "a", field: "title", before: "a", after: "A2" },
      { rowId: "b", field: "*", before: null, after: after.rows.b },
      { rowId: "s", field: "*", before: before.rows.s, after: null },
    ]);
  });

  it("replays forward to the new state and backward to the old one", () => {
    const after = { rows: { a: { ...before.rows.a!, title: "A2" }, b: task("b", { position: "a5" }) }, links: {} };
    const changes = diffState(before, after);
    expect(applyChanges(before, changes)).toEqual(after);
    expect(applyChanges(after, changes, "backward")).toEqual(before);
  });

  it("refuses to change a missing row", () => {
    expect(() => applyChanges(before, [{ rowId: "x", field: "title", before: "", after: "X" }])).toThrow(RangeError);
  });

  describe("links", () => {
    const base = project(task("A"), task("B"), task("C"));
    const withLinks = (...links: Link[]): ProjectState => ({ ...base, links: Object.fromEntries(links.map((l) => [linkKey(l), l])) });

    it("diffState lists row changes by row id, then link changes by key", () => {
      const after = { ...withLinks(link("A", "B")), rows: { ...base.rows, B: { ...base.rows.B!, title: "B2" } } };
      expect(diffState(base, after)).toEqual([
        { rowId: "B", field: "title", before: "B", after: "B2" },
        { link: { predecessorId: "A", followerId: "B", kind: "FS" }, field: "*", before: null, after: { predecessorId: "A", followerId: "B", kind: "FS", lag: 0 } },
      ]);
    });

    it("a lag edit is one field change", () => {
      expect(diffState(withLinks(link("A", "B")), withLinks(link("A", "B", -1)))).toEqual([
        { link: { predecessorId: "A", followerId: "B", kind: "FS" }, field: "lag", before: 0, after: -1 },
      ]);
    });

    it("a kind change is a delete plus a create", () => {
      expect(diffState(withLinks(link("A", "B")), withLinks(link("A", "B", 0, "SS")))).toEqual([
        { link: { predecessorId: "A", followerId: "B", kind: "FS" }, field: "*", before: link("A", "B"), after: null },
        { link: { predecessorId: "A", followerId: "B", kind: "SS" }, field: "*", before: null, after: link("A", "B", 0, "SS") },
      ]);
    });

    it("applyChanges round-trips", () => {
      const start = withLinks(link("A", "B"), link("A", "C", 1, "FF"));
      const end: ProjectState = {
        rows: { A: base.rows.A!, B: { ...base.rows.B!, title: "B2" }, D: task("D", { position: "a9" }) },
        links: Object.fromEntries([link("A", "B", -1), link("D", "B", 0, "SS")].map((l) => [linkKey(l), l])),
      };
      const changes = diffState(start, end);
      expect(applyChanges(start, changes)).toEqual(end);
      expect(applyChanges(applyChanges(start, changes), changes, "backward")).toEqual(start);
    });

    it("treats a state without links as having none", () => {
      const created = diffState(base, withLinks(link("A", "B")));
      expect(applyChanges({ rows: base.rows } as ProjectState, created)).toEqual(withLinks(link("A", "B")));
    });

    it("replays an old logged create without fields rows no longer have", () => {
      const created = applyChanges(base, [{ rowId: "D", field: "*", before: null, after: { ...task("D"), predecessorId: "A", offset: 2 } }]);
      expect(created.rows.D).toEqual(task("D"));
    });

    it("refuses to change the lag of a missing link", () => {
      expect(() => applyChanges(base, [{ link: { predecessorId: "A", followerId: "B", kind: "FS" }, field: "lag", before: 0, after: 1 }])).toThrow(RangeError);
    });
  });
});

describe("changedRowIds", () => {
  it("lists each row once, with both ends of a link change", () => {
    const ref = { predecessorId: "a", followerId: "b", kind: "FS" as const };
    expect(
      changedRowIds([
        { rowId: "b", field: "title", before: "x", after: "y" },
        { link: ref, field: "lag", before: 0, after: 1 },
        { rowId: "c", field: "*", before: null, after: {} },
      ]),
    ).toEqual(["b", "a", "c"]);
  });
});
