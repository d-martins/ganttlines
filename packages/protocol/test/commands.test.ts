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
      { type: "toggleCollapsed", id: A, collapsed: true },
      { type: "setAssignee", id: A, resourceId: null },
      { type: "moveTask", id: A, start: "2026-10-05" },
      { type: "resizeTask", id: A, edge: "end", date: "2026-10-09" },
      { type: "setDuration", id: A, duration: 3 },
      { type: "convertMilestone", id: A, milestone: true },
      { type: "setLocked", id: A, locked: false },
      { type: "linkTasks", fromId: A, toId: B },
      { type: "removePredecessor", id: A },
      { type: "setOffset", id: A, offset: -2 },
      { type: "indent", id: A },
      { type: "outdent", id: A },
      { type: "moveRow", id: A, parentId: null, afterId: B },
      { type: "deleteRows", ids: [A, B] },
      { type: "duplicateTask", id: A, newId: B },
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
      { type: "setOffset", id: A, offset: 1.5 },
      { type: "moveTask", id: A, start: "9999-12-31" },
      { type: "moveTask", id: A, start: "2026-02-30" },
      { type: "updateTitle", id: A, title: "x".repeat(501) },
      { type: "deleteRows", ids: [] },
      { type: "explode", id: A },
    ];
    for (const value of bad) expect(CommandSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });

  it("wraps commands with an idempotency id", () => {
    expect(ProjectCommandBody.safeParse({ commandId: A, command: { type: "indent", id: B } }).success).toBe(true);
    expect(ProjectCommandBody.safeParse({ commandId: "1", command: { type: "indent", id: B } }).success).toBe(false);
  });
});
