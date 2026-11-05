import type { Command } from "@ganttlines/engine";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import { CommandSchema, ProjectCommandBody, toEngineCommand } from "../src/commands";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("CommandSchema", () => {
  it("accepts every engine command shape", () => {
    const commands: Command[] = [
      { type: "createRow", id: A, kind: "task", parentId: null, afterId: null, title: "T", start: "2026-10-05" },
      { type: "createRow", id: A, kind: "section", parentId: B, afterId: null, title: "S" },
      { type: "updateTitle", id: A, title: "x" },
      { type: "setDescription", id: A, description: "d" },
      { type: "setColor", id: A, color: "green" },
      { type: "setAssignee", id: A, resourceId: null },
      { type: "moveTask", id: A, start: "2026-10-05" },
      { type: "resizeTask", id: A, edge: "end", date: "2026-10-09" },
      { type: "setDuration", id: A, duration: 3 },
      { type: "setDuration", id: A, duration: 2.5 },
      { type: "setActualDuration", id: A, days: 0.5 },
      { type: "setActualDuration", id: A, days: null },
      { type: "convertMilestone", id: A, milestone: true },
      { type: "setLocked", id: A, locked: false },
      { type: "addLink", predecessorId: A, followerId: B, kind: "FS" },
      { type: "addLink", predecessorId: A, followerId: B, kind: "SS", lag: 1.5 },
      { type: "updateLink", predecessorId: A, followerId: B, kind: "FS", lag: -2, newKind: "FF" },
      { type: "addLink", predecessorId: A, followerId: B, kind: "SF", lag: 1 },
      { type: "updateLink", predecessorId: A, followerId: B, kind: "SF", newKind: "FS", reverse: true },
      { type: "removeLink", predecessorId: A, followerId: B, kind: "FF" },
      { type: "removeLink", predecessorId: A, followerId: B, kind: "FS", keepPlace: false },
      { type: "moveTask", id: A, start: "2026-10-09", half: "afternoon" },
      { type: "resizeTask", id: A, edge: "end", date: "2026-10-09", half: "morning" },
      { type: "indent", id: A },
      { type: "outdent", id: A },
      { type: "moveRow", id: A, parentId: null, afterId: B },
      { type: "deleteRows", ids: [A, B] },
      { type: "duplicateTask", id: A, newId: B },
      { type: "setTags", id: A, tags: ["UI", "Back end"] },
      { type: "setTags", id: A, tags: [] },
      { type: "setTarget", id: A, targetId: B },
      { type: "setTarget", id: A, targetId: null },
      { type: "createTargetMilestone", id: A, newId: B, title: "8.12", parentId: null, afterId: null, start: "2026-11-17" },
      { type: "createRow", id: A, kind: "task", parentId: null, afterId: null, title: "m", milestone: true },
    ];
    for (const command of commands) expect(toEngineCommand(CommandSchema.parse(command))).toEqual(command);
  });

  it("stays in sync with the engine's Command type", () => {
    expectTypeOf<Command>().toExtend<z.input<typeof CommandSchema>>();
    expectTypeOf<ReturnType<typeof toEngineCommand>>().toEqualTypeOf<Command>();
  });

  it("rejects malformed ids, unknown fields, out-of-range values and oversized text", () => {
    const bad: unknown[] = [
      { type: "updateTitle", id: "row-1", title: "x" },
      { type: "updateTitle", id: A, title: "x", extra: 1 },
      { type: "setDuration", id: A, duration: 1e9 },
      { type: "setDuration", id: A, duration: 1.25 },
      { type: "setDuration", id: A, duration: 0 },
      { type: "setActualDuration", id: A, days: 0 },
      { type: "setActualDuration", id: A, days: 0.3 },
      { type: "setOffset", id: A, offset: 1.25 },
      { type: "moveTask", id: A, start: "2026-10-09", half: "evening" },
      { type: "moveTask", id: A, start: "9999-12-31" },
      { type: "moveTask", id: A, start: "2026-02-30" },
      { type: "updateTitle", id: A, title: "x".repeat(501) },
      { type: "deleteRows", ids: [] },
      { type: "explode", id: A },
      { type: "setTags", id: A, tags: "UI" },
      { type: "setTarget", id: A },
      { type: "setTarget", id: A, targetId: "nope" },
      { type: "createTargetMilestone", id: A, newId: B, title: "8.12", parentId: null, afterId: null },
      { type: "createRow", id: A, kind: "task", parentId: null, afterId: null, title: "m", milestone: "yes" },
      { type: "setTags", id: A, tags: ["x".repeat(101)] },
      { type: "setTags", id: A, tags: Array.from({ length: 51 }, (_, i) => `t${i}`) },
    ];
    for (const value of bad) expect(CommandSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });

  it("wraps commands with an idempotency id", () => {
    expect(ProjectCommandBody.safeParse({ commandId: A, command: { type: "indent", id: B } }).success).toBe(true);
    expect(ProjectCommandBody.safeParse({ commandId: "1", command: { type: "indent", id: B } }).success).toBe(false);
  });

  it("parses addLink; linkTasks no longer does", () => {
    expect(CommandSchema.safeParse({ type: "addLink", predecessorId: A, followerId: B, kind: "FF", lag: 2 }).success).toBe(true);
    expect(CommandSchema.safeParse({ type: "addLink", predecessorId: A, followerId: B, kind: "SF" }).success).toBe(true);
    expect(CommandSchema.safeParse({ type: "addLink", predecessorId: A, followerId: B, kind: "XX" }).success).toBe(false);
    expect(CommandSchema.safeParse({ type: "updateLink", predecessorId: A, followerId: B, kind: "FS", reverse: "yes" }).success).toBe(false);
    expect(CommandSchema.safeParse({ type: "linkTasks", fromId: A, toId: B }).success).toBe(false);
    expect(CommandSchema.safeParse({ type: "removePredecessor", id: A }).success).toBe(false);
    expect(CommandSchema.safeParse({ type: "setOffset", id: A, offset: 1 }).success).toBe(false);
  });

  it("allows tags up to the engine's limits, trimmed", () => {
    expect(CommandSchema.safeParse({ type: "setTags", id: A, tags: ["x".repeat(100)] }).success).toBe(true);
    expect(CommandSchema.safeParse({ type: "setTags", id: A, tags: Array.from({ length: 50 }, (_, i) => `t${i}`) }).success).toBe(true);
    expect(CommandSchema.parse({ type: "setTags", id: A, tags: [`  ${"y".repeat(100)}  `] })).toMatchObject({ tags: ["y".repeat(100)] });
  });

  it("refuses a lag of 0.25 or beyond the limit", () => {
    for (const lag of [0.25, 3660.5, -3661]) {
      expect(CommandSchema.safeParse({ type: "addLink", predecessorId: A, followerId: B, kind: "FS", lag }).success, String(lag)).toBe(false);
    }
    expect(CommandSchema.safeParse({ type: "updateLink", predecessorId: A, followerId: B, kind: "FS", lag: -3660 }).success).toBe(true);
  });
});
