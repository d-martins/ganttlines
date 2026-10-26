import { describe, expect, it } from "vitest";
import { ClientMessage } from "../src/realtime";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("ClientMessage", () => {
  it("accepts join, leave, commands and undo/redo", () => {
    for (const message of [
      { type: "join", projectId: A, version: 0, protocol: 2 },
      { type: "leave" },
      { type: "command", commandId: A, command: { type: "indent", id: B } },
      { type: "undo", commandId: A },
      { type: "redo", commandId: A },
    ]) {
      expect(ClientMessage.safeParse(message).success, JSON.stringify(message)).toBe(true);
    }
  });

  it("rejects unknown types and malformed commands", () => {
    for (const message of [{ type: "shout" }, { type: "join", projectId: "p", version: 0, protocol: 2 }, { type: "command", commandId: A, command: { type: "indent" } }]) {
      expect(ClientMessage.safeParse(message).success).toBe(false);
    }
  });

  it("refuses a join without protocol 2", () => {
    expect(ClientMessage.safeParse({ type: "join", projectId: A, version: 0 }).success).toBe(false);
    expect(ClientMessage.safeParse({ type: "join", projectId: A, version: 0, protocol: 1 }).success).toBe(false);
  });
});
