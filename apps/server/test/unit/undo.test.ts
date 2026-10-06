import { describe, it } from "vitest";
import { MemoryUndoStore } from "../../src/projects/undo-store";
import { expectUndoHistory } from "../undo-history";

describe("undo history (in memory)", () => {
  it("keeps separate, bounded histories per user and project, and clears redo on new commands", async () => {
    await expectUndoHistory(new MemoryUndoStore(2), "p");
  });
});
