import { expect } from "vitest";
import type { Calendar } from "../src/calendar";
import { applyCommand, type Command } from "../src/commands";
import type { ProjectState } from "../src/model";

/** Applies commands in order, failing the test if any is rejected. */
export function run(state: ProjectState, calendar: Calendar, ...commands: Command[]): ProjectState {
  let current = state;
  for (const command of commands) {
    const result = applyCommand(current, calendar, command);
    if (!result.ok) expect.fail(`${command.type} rejected: ${result.reason} — ${result.message}`);
    current = result.state;
  }
  return current;
}
