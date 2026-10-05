import { expect } from "vitest";
import type { UndoStore } from "../src/projects/undo-store";

/** What every undo store must do (made with a limit of 2). */
export async function expectUndoHistory(stacks: UndoStore, projectId: string): Promise<void> {
  const popUndo = async (key: string) => {
    const top = await stacks.peek("undo", projectId, key);
    await stacks.pop("undo", projectId, key);
    return top;
  };
  for (const id of ["c1", "c2", "c3"]) await stacks.pushCommand(projectId, "u1", id);
  await stacks.pushCommand(projectId, "u2", "other");
  expect(await popUndo("u1")).toBe("c3");
  await stacks.pushUndone(projectId, "u1", "c3");
  expect(await popUndo("u1")).toBe("c2");
  expect(await popUndo("u1")).toBeUndefined(); // c1 fell off (limit 2)
  await stacks.pushCommand(projectId, "u1", "c4");
  expect(await stacks.peek("redo", projectId, "u1")).toBeUndefined(); // a new command clears redo
  expect(await popUndo("u2")).toBe("other");
}
