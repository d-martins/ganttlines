import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Calendar } from "../src/calendar";
import { applyChanges } from "../src/changes";
import { applyCommand, type Command } from "../src/commands";
import { fromDay, toDay } from "../src/date";
import type { ProjectState, Row } from "../src/model";
import { computeSchedule, constraintsFor, hasCycle } from "../src/schedule";
import { buildTree, isParentTask } from "../src/tree";
import { project, section, task } from "./fixtures";

const BASE = toDay("2026-10-01");
const RESOURCES = [null, "ana", "rudy"] as const;
const dayArb = fc.integer({ min: 0, max: 60 }).map((n) => fromDay(BASE + n));

const calendarArb = fc
  .record({
    workingWeekdays: fc.uniqueArray(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 7 }),
    holidays: fc.array(
      fc.record({ start: fc.integer({ min: 0, max: 80 }), length: fc.integer({ min: 0, max: 3 }), team: fc.boolean() }),
      { maxLength: 4 },
    ),
    timeOff: fc.array(
      fc.record({ start: fc.integer({ min: 0, max: 80 }), length: fc.integer({ min: 0, max: 5 }), resource: fc.constantFrom("ana", "rudy") }),
      { maxLength: 4 },
    ),
  })
  .map(
    ({ workingWeekdays, holidays, timeOff }) =>
      new Calendar({
        workingWeekdays,
        holidays: holidays.map((h, i) => ({
          id: `h${i}`, name: "", startDate: fromDay(BASE + h.start), endDate: fromDay(BASE + h.start + h.length),
          appliesTo: h.team ? "all" : ["ana"],
        })),
        timeOff: timeOff.map((t, i) => ({
          id: `t${i}`, resourceId: t.resource, startDate: fromDay(BASE + t.start), endDate: fromDay(BASE + t.start + t.length),
        })),
      }),
  );

/**
 * Random tasks and sections; predecessors and parents only point to earlier rows. Sections
 * only sit under sections (or the root); only tasks have predecessors.
 */
const projectArb = fc
  .array(
    fc.record({
      section: fc.integer({ min: 0, max: 99 }).map((n) => n < 20),
      userStart: fc.option(dayArb, { freq: 6 }),
      duration: fc.integer({ min: 0, max: 10 }).map((halves) => halves / 2),
      resource: fc.constantFrom(...RESOURCES),
      locked: fc.integer({ min: 0, max: 99 }).map((n) => n < 15),
      predecessor: fc.option(fc.nat(), { freq: 2 }),
      parent: fc.option(fc.nat(), { freq: 4 }),
      offset: fc.integer({ min: -3, max: 3 }),
    }),
    { minLength: 1, maxLength: 12 },
  )
  .map((specs) => {
    const isSection = (i: number) => specs[i]!.section;
    return project(
      ...specs.map((spec, i) => {
        const parent = i > 0 && spec.parent !== null ? spec.parent % i : null;
        const parentId = parent === null || (spec.section && !isSection(parent)) ? null : `t${parent}`;
        if (spec.section) return section(`t${i}`, { parentId });
        const predecessor = i > 0 && spec.predecessor !== null ? spec.predecessor % i : null;
        return task(`t${i}`, {
          userStart: spec.userStart,
          duration: spec.duration,
          resourceId: spec.resource,
          locked: spec.locked,
          predecessorId: predecessor === null || isSection(predecessor) ? null : `t${predecessor}`,
          parentId,
          offset: spec.offset,
        });
      }),
    );
  });

/** Ids that do not exist yet (for createRow / duplicateTask) plus one that never exists. */
const FRESH_IDS = ["n0", "n1", "n2", "n3"];
const UNKNOWN_ID = "gone";

const commandArb = (existing: string[]): fc.Arbitrary<Command> => {
  // Mostly existing rows; sometimes rows created during the run, or one that never exists.
  const id = fc.oneof({ weight: 6, arbitrary: fc.constantFrom(...existing) }, { weight: 1, arbitrary: fc.constantFrom(...FRESH_IDS, UNKNOWN_ID) });
  const parentId = fc.option(id, { nil: null, freq: 2 });
  const freshId = fc.constantFrom(...FRESH_IDS);
  return fc.oneof(
    fc
      .record({ id: freshId, kind: fc.constantFrom("task" as const, "section" as const), parentId, afterId: parentId, start: fc.option(dayArb, { nil: null }) })
      .map(({ start, ...fields }): Command => ({ type: "createRow", title: "", ...fields, ...(start === null ? {} : { start }) })),
    fc.record({ type: fc.constant("deleteRows" as const), ids: fc.uniqueArray(id, { maxLength: 2 }) }),
    fc.record({ type: fc.constant("moveRow" as const), id, parentId, afterId: parentId }),
    fc.record({ type: fc.constant("duplicateTask" as const), id, newId: freshId }),
    fc.record({ type: fc.constant("setDuration" as const), id, duration: fc.integer({ min: 0, max: 12 }).map((halves) => halves / 2) }),
    fc.record({ type: fc.constant("setActualDuration" as const), id, days: fc.option(fc.integer({ min: 0, max: 12 }).map((halves) => halves / 2)) }),
    fc.record({ type: fc.constant("convertMilestone" as const), id, milestone: fc.boolean() }),
    fc.record({ type: fc.constant("moveTask" as const), id, start: dayArb }),
    fc.record({ type: fc.constant("resizeTask" as const), id, edge: fc.constantFrom("start" as const, "end" as const), date: dayArb }),
    fc.record({ type: fc.constant("linkTasks" as const), fromId: id, toId: id }),
    // Weighted up: offsets only apply to tasks with a predecessor (parents included).
    { weight: 3, arbitrary: fc.record({ type: fc.constant("setOffset" as const), id, offset: fc.integer({ min: -5, max: 5 }) }) },
    fc.record({ type: fc.constant("removePredecessor" as const), id }),
    fc.record({ type: fc.constant("setLocked" as const), id, locked: fc.boolean() }),
    fc.record({ type: fc.constant("setAssignee" as const), id, resourceId: fc.constantFrom(...RESOURCES) }),
    fc.record({ type: fc.constant("indent" as const), id }),
    fc.record({ type: fc.constant("outdent" as const), id }),
  );
};

function assertStructure(state: ProjectState): void {
  const rows = Object.values(state.rows);
  const positions = new Set<string>();
  for (const row of rows) {
    if (row.parentId !== null) {
      const parent = state.rows[row.parentId];
      expect(parent).toBeDefined();
      if (row.kind === "section") expect(parent!.kind).toBe("section");
    }
    if (row.kind === "task" && row.predecessorId !== null) expect(state.rows[row.predecessorId]).toBeDefined();
    const key = `${row.parentId ?? ""}\u0000${row.position}`;
    expect(positions.has(key)).toBe(false);
    positions.add(key);
    let current = row.parentId;
    for (let steps = rows.length; current !== null; steps--) {
      expect(steps).toBeGreaterThan(0);
      current = state.rows[current]?.parentId ?? null;
    }
  }
}

function assertScheduleInvariants(state: ProjectState, calendar: Calendar): void {
  const schedule = computeSchedule(state, calendar);
  const tree = buildTree(state);
  for (const row of Object.values(state.rows)) {
    if (row.kind !== "task" || isParentTask(tree, row)) continue;
    const span = schedule.get(row.id)?.span;
    if (row.userStart === null) {
      expect(span).toBeNull();
      continue;
    }
    if (!span) throw new Error(`scheduled task ${row.id} has no span`);
    const resource = row.resourceId;
    expect(calendar.isWorkingDay(span.start, resource)).toBe(true);
    if (row.duration === 0) expect(span.end).toBe(span.start);
    else expect(calendar.workingDaysBetween(span.start, span.end, resource) + 1).toBe(Math.ceil(row.duration));
    if (row.locked) continue;
    expect(span.start).toBeGreaterThanOrEqual(calendar.snap(toDay(row.userStart), resource));
    for (const { predecessorId, offset } of constraintsFor(state, row)) {
      const predecessor = schedule.get(predecessorId)?.span;
      if (!predecessor) continue;
      expect(span.start).toBeGreaterThan(predecessor.start);
      const natural = calendar.nextAfter(predecessor.end, resource);
      expect(span.start).toBeGreaterThanOrEqual(calendar.addWorkingDays(natural, offset, resource));
    }
  }
}

describe("scheduling properties", () => {
  it("every schedule satisfies the calendar and dependency rules", () => {
    fc.assert(
      fc.property(projectArb, calendarArb, (state, calendar) => {
        fc.pre(!hasCycle(state, calendar));
        assertScheduleInvariants(state, calendar);
      }),
      { numRuns: 300 },
    );
  });

  it("is independent of row order", () => {
    fc.assert(
      fc.property(projectArb, calendarArb, (state, calendar) => {
        fc.pre(!hasCycle(state, calendar));
        const reversed: Record<string, Row> = {};
        for (const id of Object.keys(state.rows).reverse()) reversed[id] = state.rows[id]!;
        const a = computeSchedule(state, calendar);
        const b = computeSchedule({ rows: reversed }, calendar);
        for (const id of Object.keys(state.rows)) expect(b.get(id)).toEqual(a.get(id));
      }),
      { numRuns: 200 },
    );
  });

  it("accepted commands keep the project valid and their changes replay exactly", () => {
    fc.assert(
      fc.property(
        projectArb.chain((state) => fc.tuple(fc.constant(state), fc.array(commandArb(Object.keys(state.rows)), { maxLength: 15 }))),
        calendarArb,
        ([initial, commands], calendar) => {
          fc.pre(!hasCycle(initial, calendar));
          let state = initial;
          for (const command of commands) {
            const result = applyCommand(state, calendar, command);
            if (!result.ok) continue;
            expect(hasCycle(result.state, calendar)).toBe(false);
            expect(applyChanges(state, result.changes)).toEqual(result.state);
            expect(applyChanges(result.state, result.changes, "backward")).toEqual(state);
            assertStructure(result.state);
            state = result.state;
          }
          assertScheduleInvariants(state, calendar);
        },
      ),
      { numRuns: 1000 },
    );
  });
});
