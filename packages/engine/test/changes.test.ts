import { describe, expect, it } from "vitest";
import { applyChanges, changedRowIds, diffState, type Change } from "../src/changes";
import { linkKey, pairKindChanges, type Link } from "../src/links";
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

    it("ignores an old logged change to a field rows no longer have", () => {
      const replayed = applyChanges(base, [
        { rowId: "B", field: "predecessorId", before: null, after: "A" },
        { rowId: "B", field: "offset", before: 0, after: 2 },
      ]);
      expect(replayed).toEqual(base);
      expect(applyChanges(base, [{ rowId: "B", field: "offset", before: 0, after: 2 }], "backward")).toEqual(base);
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

describe("pairKindChanges", () => {
  const fs = link("a", "b", 1);
  const ss = link("a", "b", 1, "SS");
  const deleted = (old: Link): Change => ({ link: { predecessorId: old.predecessorId, followerId: old.followerId, kind: old.kind }, field: "*", before: old, after: null });
  const created = (next: Link): Change => ({ link: { predecessorId: next.predecessorId, followerId: next.followerId, kind: next.kind }, field: "*", before: null, after: next });

  it("reads a delete and a create of the same two tasks as one kind change, where the first of the two was", () => {
    const title: Change = { rowId: "b", field: "title", before: "x", after: "y" };
    expect(pairKindChanges([title, deleted(fs), created(ss)])).toEqual([title, { link: ss, fromKind: "FS", toKind: "SS" }]);
    expect(pairKindChanges([created(ss), title, deleted(fs)])).toEqual([{ link: ss, fromKind: "FS", toKind: "SS" }, title]);
  });

  it("passes everything else through", () => {
    const other = link("c", "b", 0, "SS");
    const lag: Change = { link: { predecessorId: "a", followerId: "b", kind: "FS" }, field: "lag", before: 0, after: 1 };
    // Different pairs, a lone delete, and a lag change aren't kind changes.
    expect(pairKindChanges([deleted(fs), created(other), lag])).toEqual([deleted(fs), created(other), lag]);
    // Each delete pairs with one create only.
    const ff = link("a", "b", 0, "FF");
    expect(pairKindChanges([deleted(fs), created(ss), created(ff)])).toEqual([{ link: ss, fromKind: "FS", toKind: "SS" }, created(ff)]);
  });

  it("pairs the changes a kind change diffs to", () => {
    const before = project(task("a", { userStart: "2026-10-05" }), task("b", { userStart: "2026-10-06" }), fs);
    const after = project(task("a", { userStart: "2026-10-05" }), task("b", { userStart: "2026-10-06" }), ss);
    expect(pairKindChanges(diffState(before, after))).toEqual([{ link: ss, fromKind: "FS", toKind: "SS" }]);
  });
});
