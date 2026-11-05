import { Calendar, type ProjectState } from "@ganttlines/engine";
import { defaultParseSearch, defaultStringifySearch } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { filterRows, filtersFromSearch, isFiltering, knownFilters, NO_FILTERS, searchFromFilters, type BoardFilters } from "../src/board/filters";
import { boardModel } from "../src/board/model";
import { outline } from "../src/board/rows";
import { validateBoardSearch } from "../src/router";
import { CALENDAR, section, task } from "./board-fixtures";

/**
 * s "Design"
 *   n "Nested" (section)
 *     ui "Navigation"      Ana, [UI]
 *   p "Parent"            Rui, [Backend]
 *     c1 "Child nav"      Ana, [ui]
 *     c2 "Child api"      unassigned
 * t "Top task"            unassigned, [Docs]
 */
const state: ProjectState = {
  rows: {
    s: section("s", { title: "Design", position: "a0" }),
    n: section("n", { title: "Nested", parentId: "s", position: "a0" }),
    ui: task("ui", { title: "Navigation", parentId: "n", position: "a0", resourceId: "ana", tags: ["UI"], userStart: "2026-10-06", duration: 2 }),
    p: task("p", { title: "Parent", parentId: "s", position: "a1", resourceId: "rui", tags: ["Backend"] }),
    c1: task("c1", { title: "Child nav", parentId: "p", position: "a0", resourceId: "ana", tags: ["ui"], userStart: "2026-10-06", duration: 1 }),
    c2: task("c2", { title: "Child api", parentId: "p", position: "a1", userStart: "2026-10-12", duration: 3 }),
    t: task("t", { title: "Top task", position: "b0", tags: ["Docs"] }),
  },
  links: {},
};
const f = (fields: Partial<BoardFilters>): BoardFilters => ({ ...NO_FILTERS, ...fields });
const ids = (set: Set<string> | undefined) => [...(set ?? [])].sort();
const run = (fields: Partial<BoardFilters>) => {
  const result = filterRows(state, f(fields));
  return { matches: ids(result?.matches), context: ids(result?.context) };
};

describe("isFiltering", () => {
  it("is off with no filters or only blank search", () => {
    expect(isFiltering(NO_FILTERS)).toBe(false);
    expect(isFiltering(f({ q: "  " }))).toBe(false);
    expect(isFiltering(f({ q: "x" }))).toBe(true);
    expect(isFiltering(f({ tags: ["UI"] }))).toBe(true);
    expect(filterRows(state, NO_FILTERS)).toBeNull();
  });
});

describe("filterRows", () => {
  it("search matches titles, case-insensitive", () => {
    expect(run({ q: "NAV" }).matches).toEqual(["c1", "ui"]);
  });

  it("people picks tasks assigned to anyone listed", () => {
    expect(run({ people: ["ana"] }).matches).toEqual(["c1", "ui"]);
    expect(run({ people: ["ana", "rui"] }).matches).toEqual(["c1", "p", "ui"]);
  });

  it('"none" picks unassigned tasks', () => {
    expect(run({ people: ["none"] }).matches).toEqual(["c2", "t"]);
  });

  it("tags compare without case and OR within the filter", () => {
    expect(run({ tags: ["ui"] }).matches).toEqual(["c1", "ui"]);
    expect(run({ tags: ["UI", "docs"] }).matches).toEqual(["c1", "t", "ui"]);
  });

  it("a section shows itself and everything nested in it", () => {
    expect(run({ sections: ["s"] })).toEqual({ matches: ["c1", "c2", "n", "p", "s", "ui"], context: [] });
    expect(run({ sections: ["n"] })).toEqual({ matches: ["n", "ui"], context: ["s"] });
  });

  it("filters AND together", () => {
    expect(run({ people: ["ana"], q: "child" }).matches).toEqual(["c1"]);
    expect(run({ tags: ["ui"], sections: ["n"] }).matches).toEqual(["n", "ui"]);
    expect(run({ people: ["none"], sections: ["s"] })).toEqual({ matches: ["c2", "s"], context: ["p"] });
  });

  it("search matches section titles: the section shows with everything inside it", () => {
    expect(run({ q: "DESIGN" })).toEqual({ matches: ["c1", "c2", "n", "p", "s", "ui"], context: [] });
    expect(run({ q: "nest" })).toEqual({ matches: ["n", "ui"], context: ["s"] });
  });

  it("inside a section the search matches, the other filters still pick the tasks", () => {
    expect(run({ q: "design", people: ["ana"] })).toEqual({ matches: ["c1", "s", "ui"], context: ["n", "p"] });
    expect(run({ q: "design", tags: ["backend"] })).toEqual({ matches: ["p", "s"], context: [] });
    // no task inside passes: the section still shows, alone
    expect(run({ q: "design", tags: ["docs"] })).toEqual({ matches: ["s"], context: [] });
    expect(run({ q: "nested", sections: ["s"] })).toEqual({ matches: ["n", "ui"], context: ["s"] });
    // a chosen section the search doesn't match is only context
    expect(run({ q: "child", sections: ["s"] })).toEqual({ matches: ["c1", "c2"], context: ["p", "s"] });
  });

  it("an empty section shows alone, for the section filter or the search", () => {
    const empty: ProjectState = { rows: { ...state.rows, e: section("e", { title: "Empty", position: "c0" }) }, links: {} };
    for (const fields of [{ sections: ["e"] }, { q: "empt" }]) {
      expect(filterRows(empty, f(fields))).toEqual({ matches: new Set(["e"]), context: new Set() });
      expect(outline(empty, f(fields)).visible.map((entry) => [entry.row.id, entry.context])).toEqual([["e", false]]);
    }
    expect(boardModel(empty, new Calendar(CALENDAR), null, f({ sections: ["e"] })).count).toEqual({ matching: 0, total: 5 });
  });

  it("context is every ancestor of a match that isn't a match", () => {
    expect(run({ tags: ["ui"] })).toEqual({ matches: ["c1", "ui"], context: ["n", "p", "s"] });
  });

  it("a matching parent shows only the subtasks that match on their own", () => {
    // Rui's parent matches; neither subtask is Rui's.
    expect(run({ people: ["rui"] })).toEqual({ matches: ["p"], context: ["s"] });
    // Parent and one subtask match: the other subtask stays hidden.
    expect(run({ people: ["rui", "ana"], sections: ["s"] })).toEqual({ matches: ["c1", "p", "s", "ui"], context: ["n"] });
  });

  it("ignores unknown people and sections; with nothing known left, the filter is off", () => {
    expect(run({ people: ["ghost", "ana"] }).matches).toEqual(["c1", "ui"]);
    expect(run({ tags: ["nope", "Docs"] }).matches).toEqual(["t"]);
    expect(run({ sections: ["missing", "n"] }).matches).toEqual(["n", "ui"]);
    // a task id isn't a section
    expect(run({ sections: ["p"] }).matches).toEqual([]);
    expect(filterRows(state, f({ sections: ["p"] }))).toBeNull();
    expect(filterRows(state, f({ people: ["ghost"], sections: ["missing"] }))).toBeNull();
    // only the unknown part drops: the rest still applies
    expect(run({ people: ["ghost"], q: "top" }).matches).toEqual(["t"]);
  });

  it("a tag nobody here uses stays active and matches nothing", () => {
    expect(filterRows(state, f({ tags: ["nope"] }))).toEqual({ matches: new Set(), context: new Set() });
    expect(filterRows(state, f({ people: ["ghost"], tags: ["nope"] }))).toEqual({ matches: new Set(), context: new Set() });
  });

  it("removing a tag from its only task keeps the tag filter on, with no matches", () => {
    const calendar = new Calendar(CALENDAR);
    const before = { rows: { x: task("x", { tags: ["UI"] }), y: task("y") }, links: {} };
    expect(boardModel(before, calendar, null, f({ tags: ["UI"] })).count).toEqual({ matching: 1, total: 2 });
    const after = { rows: { ...before.rows, x: task("x", { tags: [] }) }, links: {} };
    expect(filterRows(after, f({ tags: ["UI"] }))).toEqual({ matches: new Set(), context: new Set() });
    const model = boardModel(after, calendar, null, f({ tags: ["UI"] }));
    expect(model.count).toEqual({ matching: 0, total: 2 });
    expect(model.rows).toEqual([]);
  });

  it("knows the team's people even without tasks here", () => {
    expect(filterRows(state, f({ people: ["bea"] }), new Set(["ana", "bea"]))).toEqual({ matches: new Set(), context: new Set() });
    expect(filterRows(state, f({ people: ["ghost"] }), new Set(["ana", "bea"]))).toBeNull();
  });
});

describe("outline and model while filtering", () => {
  it("shows matches and context rows, marked, collapse or not", () => {
    const { visible } = outline(state, f({ tags: ["ui"] }), new Set(["s", "p"]));
    expect(visible.map((entry) => [entry.row.id, entry.context])).toEqual([
      ["s", true],
      ["n", true],
      ["ui", false],
      ["p", true],
      ["c1", false],
    ]);
  });

  it("reports no row collapsed while filtering (their children show)", () => {
    const { visible } = outline(state, f({ tags: ["ui"] }), new Set(["s", "p"]));
    expect(visible.every((entry) => !entry.collapsed)).toBe(true);
    expect(outline(state, NO_FILTERS, new Set(["s"])).visible[0]!.collapsed).toBe(true);
  });

  it("the model says whether it really filters: unknown people and sections don't", () => {
    const calendar = new Calendar(CALENDAR);
    expect(boardModel(state, calendar, null, f({ people: ["ghost"], sections: ["gone"] })).filtering).toBe(false);
    expect(boardModel(state, calendar, null, f({ people: ["ghost"] }), new Set(), new Set(["ghost"])).filtering).toBe(true);
    expect(boardModel(state, calendar, null, f({ tags: ["nope"] })).filtering).toBe(true);
    expect(boardModel(state, calendar, null).filtering).toBe(false);
  });

  it("knownFilters keeps only what filters here", () => {
    expect(knownFilters(state, f({ q: " ", people: ["ghost", "ana", "none"], sections: ["gone", "n", "p"], tags: ["x"] }))).toEqual(f({ q: " ", people: ["ana", "none"], sections: ["n"], tags: ["x"] }));
  });

  it("shows kept rows as matches, with their context, without counting them", () => {
    const calendar = new Calendar(CALENDAR);
    const model = boardModel(state, calendar, null, f({ q: "top" }), new Set(), undefined, new Set(["c2"]));
    expect(model.rows.map((entry) => [entry.row.id, entry.context])).toEqual([
      ["s", true],
      ["p", true],
      ["c2", false],
      ["t", false],
    ]);
    expect(model.count).toEqual({ matching: 1, total: 5 });
  });

  it("shows a chosen section undimmed above its tasks", () => {
    expect(outline(state, f({ sections: ["n"] })).visible.map((entry) => [entry.row.id, entry.context])).toEqual([
      ["s", true],
      ["n", false],
      ["ui", false],
    ]);
  });

  it("a kept section stays as a match", () => {
    const calendar = new Calendar(CALENDAR);
    const model = boardModel(state, calendar, null, f({ q: "top" }), new Set(), undefined, new Set(["n"]));
    expect(model.rows.map((entry) => [entry.row.id, entry.context])).toEqual([
      ["s", true],
      ["n", false],
      ["t", false],
    ]);
    expect(model.count).toEqual({ matching: 1, total: 5 });
  });

  it("rows aren't context when not filtering", () => {
    const { visible } = outline(state);
    expect(visible.every((entry) => !entry.context)).toBe(true);
    expect(visible).toHaveLength(7);
  });

  it("keeps a parent's span from the whole plan", () => {
    const calendar = new Calendar(CALENDAR);
    const whole = boardModel(state, calendar, null);
    const filtered = boardModel(state, calendar, null, f({ q: "child nav" }));
    const span = (model: typeof whole, id: string) => model.rows.find((entry) => entry.row.id === id)!.span;
    expect(filtered.rows.map((entry) => entry.row.id)).toEqual(["s", "p", "c1"]);
    expect(span(filtered, "p")).toEqual(span(whole, "p"));
    expect(span(filtered, "s")).toEqual(span(whole, "s"));
    expect(filtered.rows.find((entry) => entry.row.id === "p")!.workedDays).toBe(whole.rows.find((entry) => entry.row.id === "p")!.workedDays);
  });

  it("counts matching tasks over all tasks", () => {
    const calendar = new Calendar(CALENDAR);
    expect(boardModel(state, calendar, null).count).toEqual({ matching: 5, total: 5 });
    expect(boardModel(state, calendar, null, f({ tags: ["ui"] })).count).toEqual({ matching: 2, total: 5 });
    expect(boardModel(state, calendar, null, f({ q: "zzz" })).count).toEqual({ matching: 0, total: 5 });
    // matching sections show but aren't counted
    expect(boardModel(state, calendar, null, f({ sections: ["s"] })).count).toEqual({ matching: 4, total: 5 });
    expect(boardModel(state, calendar, null, f({ q: "design" })).count).toEqual({ matching: 4, total: 5 });
  });
});

describe("filters in the address", () => {
  const roundTrip = (filters: BoardFilters) => {
    const url = defaultStringifySearch({ baseline: "22222222-2222-4222-8222-222222222222", ...searchFromFilters(filters) });
    const search = validateBoardSearch(defaultParseSearch(url));
    return { url, search, filters: filtersFromSearch(search) };
  };

  it("survives tags with commas, symbols, emoji and spaces", () => {
    const filters = f({ q: "a & b, c", people: ["ana", "none"], tags: ["a,b", "R&D #1 🚀", "Q4 · must-have"], sections: ["s"] });
    const { search, filters: back } = roundTrip(filters);
    expect(back).toEqual(filters);
    expect(search.baseline).toBe("22222222-2222-4222-8222-222222222222");
    // and filters by the tag that went through it
    const tagged = { rows: { x: task("x", { tags: ["R&D #1 🚀"] }), y: task("y", { tags: ["a"] }) }, links: {} };
    expect(ids(filterRows(tagged, roundTrip(f({ tags: ["R&D #1 🚀"] })).filters)?.matches)).toEqual(["x"]);
  });

  it("keeps a numeric-looking search a string", () => {
    expect(roundTrip(f({ q: "2026" })).filters.q).toBe("2026");
  });

  it("keeps numeric-looking list entries as strings", () => {
    expect(validateBoardSearch(defaultParseSearch("?tags=2026&people=7&sections=3"))).toEqual({ tags: ["2026"], people: ["7"], sections: ["3"] });
    expect(roundTrip(f({ tags: ["2026", "42"] })).filters.tags).toEqual(["2026", "42"]);
  });

  it("leaves empty filters out of the address", () => {
    expect(searchFromFilters(NO_FILTERS)).toEqual({});
    expect(defaultStringifySearch(searchFromFilters(f({ q: "  " })))).toBe("");
  });

  it("drops entries that aren't strings and keeps the baseline rules", () => {
    expect(validateBoardSearch({ people: ["ana", 3, null, Infinity], tags: "ui", sections: { a: 1 }, q: 7 })).toEqual({ people: ["ana", "3"], tags: ["ui"], q: "7" });
    expect(validateBoardSearch({ baseline: "nope", compare: "switch" })).toEqual({});
    expect(validateBoardSearch({ baseline: "22222222-2222-4222-8222-222222222222", compare: "switch" })).toEqual({
      baseline: "22222222-2222-4222-8222-222222222222",
      compare: "switch",
    });
    expect(filtersFromSearch({})).toEqual(NO_FILTERS);
  });
});

describe("filtering by milestone", () => {
  const plan: ProjectState = {
    rows: {
      p: task("p", { position: "a0", userStart: "2026-10-12", targetId: "m" }),
      kid: task("kid", { parentId: "p", position: "a0", userStart: "2026-10-12", resourceId: "ana" }),
      other: task("other", { parentId: "p", position: "a1", userStart: "2026-10-12", targetId: "n" }),
      own: task("own", { position: "a1", userStart: "2026-10-12", targetId: "m", resourceId: "rui" }),
      feeder: task("feeder", { position: "a2", userStart: "2026-10-12" }),
      far: task("far", { position: "a3", userStart: "2026-10-12" }),
      feedsParent: task("feedsParent", { position: "a4", userStart: "2026-10-12" }),
      group: task("group", { position: "a5", userStart: "2026-10-12" }),
      inGroup: task("inGroup", { parentId: "group", position: "a0", userStart: "2026-10-12" }),
      unrelated: task("unrelated", { position: "a6", userStart: "2026-10-12" }),
      m: task("m", { position: "a7", userStart: "2026-10-20", duration: 0 }),
      n: task("n", { position: "a8", userStart: "2026-10-21", duration: 0 }),
      plain: task("plain", { position: "a9", userStart: "2026-10-21" }),
    },
    links: {
      "own|feeder|FS": { predecessorId: "feeder", followerId: "own", kind: "FS", lag: 0 },
      "feeder|far|FS": { predecessorId: "far", followerId: "feeder", kind: "FS", lag: 0 },
      "p|feedsParent|FS": { predecessorId: "feedsParent", followerId: "p", kind: "FS", lag: 0 },
      "feedsParent|group|FS": { predecessorId: "group", followerId: "feedsParent", kind: "FS", lag: 0 },
    },
  };
  const matched = (milestones: string[], extra: Partial<BoardFilters> = {}) => [...(filterRows(plan, { ...NO_FILTERS, milestones, ...extra }, new Set(["ana", "rui"]))?.matches ?? [])].sort();

  it("matches what aims for it, directly and by inheritance, what feeds it, and the milestone itself", () => {
    expect(matched(["m"])).toEqual(["far", "feeder", "feedsParent", "group", "inGroup", "kid", "m", "own", "p"].sort());
  });

  it("leaves out a subtask with a different target", () => {
    expect(matched(["m"])).not.toContain("other");
    // A link into a parent holds back everything under it, so what feeds `p` feeds `other` too.
    expect(matched(["n"])).toEqual(["feedsParent", "group", "inGroup", "n", "other"]);
  });

  it("is OR within the filter, and AND with the others", () => {
    expect(matched(["n", "m"])).toEqual(expect.arrayContaining(["n", "other", "m", "own"]));
    expect(matched(["m"], { people: ["rui"] })).toEqual(["own"]);
  });

  it("takes in what interrupts a matching task", () => {
    const interrupted: ProjectState = {
      rows: {
        a: task("a", { position: "a0", userStart: "2026-10-12", targetId: "m", interruptedBy: ["hotfix"] }),
        hotfix: task("hotfix", { position: "a1", userStart: "2026-10-13" }),
        other: task("other", { position: "a2", userStart: "2026-10-13" }),
        m: task("m", { position: "a3", userStart: "2026-10-20", duration: 0 }),
      },
      links: {},
    };
    expect([...filterRows(interrupted, { ...NO_FILTERS, milestones: ["m"] }, new Set())!.matches].sort()).toEqual(["a", "hotfix", "m"]);
  });

  it("an id that's gone or no longer a milestone drops out, and the board isn't emptied", () => {
    expect(knownFilters(plan, { ...NO_FILTERS, milestones: ["gone", "plain", "p", "m"] }).milestones).toEqual(["m"]);
    expect(filterRows(plan, { ...NO_FILTERS, milestones: ["gone", "plain"] })).toBeNull();
    expect(isFiltering({ ...NO_FILTERS, milestones: ["m"] })).toBe(true);
  });

  it("survives the address, and a malformed value is dropped", () => {
    const search = validateBoardSearch(defaultParseSearch(defaultStringifySearch(searchFromFilters({ ...NO_FILTERS, milestones: ["m", "n"] }))));
    expect(search.milestones).toEqual(["m", "n"]);
    expect(filtersFromSearch(search).milestones).toEqual(["m", "n"]);
    expect(validateBoardSearch({ milestones: [{}, null] }).milestones).toBeUndefined();
  });
});
