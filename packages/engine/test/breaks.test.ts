import { describe, expect, it } from "vitest";
import { applyCommand, MAX_BREAKS_PER_TASK, MAX_DURATION, type Command } from "../src/commands";
import { MAX_LINKS_PER_TASK } from "../src/links";
import { fromDay } from "../src/date";
import type { ProjectState, RowId, TaskRow } from "../src/model";
import { partsOf } from "../src/parts";
import { computeSchedule } from "../src/schedule";
import { revertChanges } from "../src/undo";
import { calendar, link, project, task } from "./fixtures";
import { run } from "./helpers";

const cal = calendar();
const MON = "2026-11-02";
const [TUE, WED, THU, FRI] = ["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"];
const taskIn = (state: ProjectState, id: RowId) => state.rows[id] as TaskRow;
const dates = (state: ProjectState, id: RowId) => partsOf(computeSchedule(state, cal).get(id)).map((part) => [fromDay(part.start), fromDay(part.end)]);
const twoDays = (fields: Partial<TaskRow> = {}) => project(task("t", { userStart: MON, duration: 2, ...fields }));
const split = (fields: Partial<TaskRow> = {}) => twoDays({ breaks: [{ after: 2, length: 6 }], ...fields }); // Monday and Friday
const refused = (state: ProjectState, command: Command) => {
  const result = applyCommand(state, cal, command);
  if (result.ok) throw new Error(`${command.type} was accepted`);
  return result;
};
const expectUndoes = (state: ProjectState, command: Command) => {
  const result = applyCommand(state, cal, command);
  if (!result.ok) throw new Error(result.message);
  expect(revertChanges(result.state, result.changes, "undo").state).toEqual(state);
  return result.state;
};

describe("addBreak", () => {
  it("pauses the task, past its current end, and undoes", () => {
    const after = expectUndoes(twoDays(), { type: "addBreak", id: "t", from: TUE, resume: FRI });
    expect(taskIn(after, "t")).toMatchObject({ breaks: [{ after: 2, length: 6 }], duration: 2 });
    expect(dates(after, "t")).toEqual([[MON, MON], [FRI, FRI]]);
  });

  it("takes half days", () => {
    const after = run(twoDays(), cal, { type: "addBreak", id: "t", from: MON, fromHalf: "afternoon", resume: TUE, resumeHalf: "afternoon" });
    expect(taskIn(after, "t").breaks).toEqual([{ after: 1, length: 2 }]);
  });

  it("refuses from before half a day of work or after the last half", () => {
    expect(refused(twoDays(), { type: "addBreak", id: "t", from: MON, resume: FRI }).reason).toBe("invalid");
    expect(refused(twoDays(), { type: "addBreak", id: "t", from: WED, resume: FRI }).reason).toBe("invalid");
    expect(refused(twoDays({ userStart: TUE }), { type: "addBreak", id: "t", from: MON, resume: FRI }).reason).toBe("invalid");
  });

  it("from in a gap refuses", () => {
    expect(refused(split(), { type: "addBreak", id: "t", from: WED, resume: THU }).reason).toBe("invalid");
  });

  it("resume at or before from changes nothing", () => {
    const result = applyCommand(twoDays(), cal, { type: "addBreak", id: "t", from: TUE, resume: TUE });
    expect(result).toMatchObject({ ok: true, changes: [] });
  });

  it("a task can have several, kept in order", () => {
    const state = run(project(task("t", { userStart: MON, duration: 3 })), cal, { type: "addBreak", id: "t", from: TUE, resume: WED }, { type: "addBreak", id: "t", from: THU, resume: FRI });
    expect(taskIn(state, "t").breaks).toEqual([{ after: 2, length: 2 }, { after: 4, length: 2 }]);
    expect(dates(state, "t")).toEqual([[MON, MON], [WED, WED], [FRI, FRI]]);
  });

  it("refuses locked, milestones, parents and unscheduled tasks", () => {
    expect(refused(twoDays({ locked: true }), { type: "addBreak", id: "t", from: TUE, resume: FRI }).reason).toBe("locked");
    expect(refused(twoDays({ duration: 0 }), { type: "addBreak", id: "t", from: MON, resume: FRI }).reason).toBe("invalid");
    expect(refused(twoDays({ userStart: null }), { type: "addBreak", id: "t", from: TUE, resume: FRI }).reason).toBe("unscheduled");
    expect(refused(project(task("t", { userStart: MON }), task("kid", { userStart: MON, parentId: "t" })), { type: "addBreak", id: "t", from: TUE, resume: FRI }).reason).toBe("invalid");
  });
});

describe("limits keep every calendar walk bounded", () => {
  it("refuses pauses longer than a task may be, one at a time or added up", () => {
    expect(refused(twoDays(), { type: "addBreak", id: "t", from: TUE, resume: "2199-12-30" }).message).toBe("An interruption can't run that long");
    const nearly = twoDays({ breaks: [{ after: 2, length: MAX_DURATION * 2 - 2 }] });
    expect(refused(nearly, { type: "addBreak", id: "t", from: MON, fromHalf: "afternoon", resume: FRI }).message).toBe("An interruption can't run that long");
  });

  it("refuses more breaks than a task may have", () => {
    const full = project(task("t", { userStart: MON, duration: 200, breaks: Array.from({ length: MAX_BREAKS_PER_TASK }, (_, i) => ({ after: i + 1, length: 1 })) }));
    const span = computeSchedule(full, cal).get("t")!.span!;
    const late = fromDay(span.end - 2);
    expect(refused(full, { type: "addBreak", id: "t", from: late, resume: fromDay(span.end + 5) }).message).toBe(`A task can have at most ${MAX_BREAKS_PER_TASK} interruptions`);
  });

  it("refuses more interrupters than a task may have", () => {
    const others = Array.from({ length: MAX_LINKS_PER_TASK + 1 }, (_, i) => task(`o${i}`, { userStart: "2030-01-07" }));
    const full = project(...others, task("b", { userStart: MON, interruptedBy: others.slice(0, MAX_LINKS_PER_TASK).map((row) => row.id) }));
    expect(refused(full, { type: "addInterruption", id: "b", byId: `o${MAX_LINKS_PER_TASK}` }).message).toBe(`A task can have at most ${MAX_LINKS_PER_TASK} tasks interrupting it`);
  });
});

describe("removeBreak", () => {
  it("brings the finish back in; WD stays", () => {
    const after = expectUndoes(split(), { type: "removeBreak", id: "t", after: 2 });
    expect(taskIn(after, "t")).toMatchObject({ breaks: [], duration: 2 });
    expect(dates(after, "t")).toEqual([[MON, TUE]]);
  });

  it("refuses a break that isn't there", () => {
    expect(refused(split(), { type: "removeBreak", id: "t", after: 1 }).reason).toBe("not_found");
  });
});

describe("resizeBreak", () => {
  const resized = (state: ProjectState, edge: "start" | "end", date: string, half?: "morning" | "afternoon") => expectUndoes(state, { type: "resizeBreak", id: "t", after: 2, edge, date, ...(half ? { half } : {}) });

  it("start edge later: the part grows, the gap shrinks, WD up", () => {
    const after = resized(split(), "start", TUE);
    expect(taskIn(after, "t")).toMatchObject({ duration: 3, breaks: [{ after: 4, length: 4 }] });
    expect(dates(after, "t")).toEqual([[MON, TUE], [FRI, FRI]]);
  });

  it("end edge earlier: same from the other side, the later part's end stays", () => {
    const after = resized(split(), "end", THU);
    expect(taskIn(after, "t")).toMatchObject({ duration: 3, breaks: [{ after: 2, length: 4 }] });
    expect(dates(after, "t")).toEqual([[MON, MON], [THU, FRI]]);
  });

  it("end edge later: part shrinks, WD down, stops at half a day", () => {
    const long = twoDays({ duration: 3, breaks: [{ after: 2, length: 2 }] }); // Monday; Wednesday and Thursday
    const after = resized(long, "end", THU);
    expect(taskIn(after, "t")).toMatchObject({ duration: 2, breaks: [{ after: 2, length: 4 }] });
    const stopped = resized(long, "end", "2026-11-20");
    expect(taskIn(stopped, "t").duration).toBe(1.5);
    expect(dates(stopped, "t").at(-1)).toEqual([THU, THU]);
  });

  it("start edge earlier stops at half a day", () => {
    const after = expectUndoes(twoDays({ duration: 3, breaks: [{ after: 4, length: 2 }] }), { type: "resizeBreak", id: "t", after: 4, edge: "start", date: "2026-10-01" });
    expect(taskIn(after, "t")).toMatchObject({ duration: 1.5, breaks: [{ after: 1, length: 5 }] });
  });

  it("an edge reaching the other side closes the gap and the task keeps that length", () => {
    const fromLeft = resized(split(), "start", FRI);
    expect(taskIn(fromLeft, "t")).toMatchObject({ duration: 5, breaks: [] });
    expect(dates(fromLeft, "t")).toEqual([[MON, FRI]]);
    const fromRight = resized(split(), "end", MON);
    expect(taskIn(fromRight, "t")).toMatchObject({ duration: 5, breaks: [] });
    expect(dates(fromRight, "t")).toEqual([[MON, FRI]]);
  });

  it("later breaks' parts don't move", () => {
    const state = twoDays({ duration: 3, breaks: [{ after: 2, length: 2 }, { after: 4, length: 2 }] }); // Mon, Wed, Fri
    const after = resized(state, "start", "2026-11-03", "morning"); // Monday plus Tuesday morning
    expect(taskIn(after, "t").breaks).toEqual([{ after: 3, length: 1 }, { after: 5, length: 2 }]);
    expect(dates(after, "t").at(-1)).toEqual([FRI, FRI]);
  });
});

describe("resizeTask with parts", () => {
  it("start edge keeps the gap and later parts", () => {
    const after = expectUndoes(twoDays({ duration: 3, breaks: [{ after: 4, length: 2 }] }), { type: "resizeTask", id: "t", edge: "start", date: TUE });
    expect(taskIn(after, "t")).toMatchObject({ userStart: TUE, duration: 2, breaks: [{ after: 2, length: 2 }] });
    expect(dates(after, "t")).toEqual([[TUE, TUE], [THU, THU]]);
  });

  it("end edge changes the last part", () => {
    const after = expectUndoes(split(), { type: "resizeTask", id: "t", edge: "end", date: "2026-11-09" });
    expect(taskIn(after, "t")).toMatchObject({ duration: 3, breaks: [{ after: 2, length: 6 }] });
    expect(dates(after, "t")).toEqual([[MON, MON], [FRI, "2026-11-09"]]);
  });

  it("both stop at half a day", () => {
    const end = run(split(), cal, { type: "resizeTask", id: "t", edge: "end", date: "2026-10-01" });
    expect(taskIn(end, "t").duration).toBe(1.5);
    const start = run(split(), cal, { type: "resizeTask", id: "t", edge: "start", date: "2026-12-01" });
    expect(taskIn(start, "t").duration).toBe(1.5);
    expect(taskIn(start, "t").breaks).toEqual([{ after: 1, length: 6 }]);
  });

  it("shrinking below a break drops it, as one undo", () => {
    const state = twoDays({ duration: 3, breaks: [{ after: 4, length: 2 }] });
    const typed = expectUndoes(state, { type: "setDuration", id: "t", duration: 1 });
    expect(taskIn(typed, "t").breaks).toEqual([]);
    expect(dates(typed, "t")).toEqual([[MON, MON]]);
  });

  it("an interrupted task resizes by its work, not its span", () => {
    const state = project(task("a", { userStart: TUE, duration: 3 }), task("t", { userStart: MON, duration: 2, interruptedBy: ["a"] }));
    const after = run(state, cal, { type: "resizeTask", id: "t", edge: "end", date: "2026-11-09" });
    expect(taskIn(after, "t").duration).toBe(3);
    expect(dates(after, "t")).toEqual([[MON, MON], [FRI, "2026-11-09"]]);
  });
});

describe("interruptions", () => {
  const pair = (a: Partial<TaskRow> = {}, b: Partial<TaskRow> = {}) => project(task("a", { userStart: TUE, duration: 3, ...a }), task("b", { userStart: MON, duration: 2, ...b }));
  const add: Command = { type: "addInterruption", id: "b", byId: "a" };

  it("breaks B around A, and undoes", () => {
    const after = expectUndoes(pair(), add);
    expect(taskIn(after, "b").interruptedBy).toEqual(["a"]);
    expect(dates(after, "b")).toEqual([[MON, MON], [FRI, FRI]]);
  });

  it("a late interrupter does nothing until it overlaps", () => {
    const after = run(pair({ userStart: "2026-11-16" }), cal, add);
    expect(dates(after, "b")).toEqual([[MON, TUE]]);
    expect(dates(run(after, cal, { type: "moveTask", id: "a", start: TUE }), "b")).toEqual([[MON, MON], [FRI, FRI]]);
  });

  it("removing it closes the gap", () => {
    const after = expectUndoes(run(pair(), cal, add), { type: "removeInterruption", id: "b", byId: "a" });
    expect(dates(after, "b")).toEqual([[MON, TUE]]);
  });

  it("refuses what can't take part", () => {
    expect(refused(pair(), { type: "addInterruption", id: "b", byId: "b" }).reason).toBe("invalid");
    expect(refused(pair({ duration: 0 }), add).message).toBe("A milestone can't interrupt or be interrupted");
    expect(refused(pair({}, { duration: 0 }), add).message).toBe("A milestone can't interrupt or be interrupted");
    expect(refused(pair({}, { locked: true }), add).reason).toBe("locked");
    expect(refused(run(pair(), cal, add), add).reason).toBe("invalid");
    expect(refused(pair({ userStart: null }), add).reason).toBe("unscheduled");
    const family = project(task("up", { userStart: MON }), task("kid", { userStart: MON, parentId: "up" }), task("b", { userStart: MON }));
    expect(refused(family, { type: "addInterruption", id: "b", byId: "up" }).message).toBe("Parent tasks can't interrupt or be interrupted");
    expect(refused(family, { type: "addInterruption", id: "up", byId: "b" }).message).toBe("Parent tasks can't interrupt or be interrupted");
  });

  it("refuses a cycle", () => {
    expect(refused(run(pair(), cal, add), { type: "addInterruption", id: "a", byId: "b" }).reason).toBe("cycle");
    expect(refused(project(task("a", { userStart: MON }), task("b", { userStart: MON }), link("b", "a")), add).reason).toBe("cycle");
  });

  it("an interrupted task can't be locked", () => {
    expect(refused(run(pair(), cal, add), { type: "setLocked", id: "b", locked: true }).message).toBe("Remove what interrupts it first");
  });
});

describe("relink", () => {
  const MIDDLE = { predecessorId: "a", followerId: "b", kind: "FS" as const };

  it("a link into an interruption is one undo", () => {
    const state = project(task("a", { userStart: MON, duration: 1 }), task("b", { userStart: TUE, duration: 2 }), { ...MIDDLE, lag: 0 });
    const after = expectUndoes(state, {
      type: "relink",
      steps: [
        { type: "removeLink", ...MIDDLE, keepPlace: false },
        { type: "addInterruption", id: "b", byId: "a" },
      ],
    });
    expect(Object.values(after.links)).toEqual([]);
    expect(taskIn(after, "b").interruptedBy).toEqual(["a"]);
  });

  it("changing an interruption's dates is one undo", () => {
    const after = expectUndoes(split(), {
      type: "relink",
      steps: [
        { type: "removeBreak", id: "t", after: 2 },
        { type: "addBreak", id: "t", from: TUE, resume: THU },
      ],
    });
    expect(taskIn(after, "t").breaks).toEqual([{ after: 2, length: 4 }]);
  });
});
