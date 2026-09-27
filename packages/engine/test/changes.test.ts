import { describe, expect, it } from "vitest";
import { applyChanges, diffRows } from "../src/changes";
import { project, section, task } from "./fixtures";

describe("diffRows / applyChanges", () => {
  const before = project(task("a", { userStart: "2026-10-05" }), section("s"));

  it("reports nothing for identical states", () => {
    expect(diffRows(before, before)).toEqual([]);
  });

  it("reports changed fields, created rows and deleted rows in row-id order", () => {
    const after = {
      rows: {
        a: { ...before.rows.a!, title: "A2" },
        b: task("b", { position: "a5" }),
      },
    };
    expect(diffRows(before, after)).toEqual([
      { rowId: "a", field: "title", before: "a", after: "A2" },
      { rowId: "b", field: "*", before: null, after: after.rows.b },
      { rowId: "s", field: "*", before: before.rows.s, after: null },
    ]);
  });

  it("replays forward to the new state and backward to the old one", () => {
    const after = { rows: { a: { ...before.rows.a!, title: "A2" }, b: task("b", { position: "a5" }) } };
    const changes = diffRows(before, after);
    expect(applyChanges(before, changes)).toEqual(after);
    expect(applyChanges(after, changes, "backward")).toEqual(before);
  });

  it("refuses to change a missing row", () => {
    expect(() => applyChanges(before, [{ rowId: "x", field: "title", before: "", after: "X" }])).toThrow(RangeError);
  });
});
