import type { Command } from "@ganttlines/engine";
import type { ProjectStateDto } from "@ganttlines/protocol";
import { waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskColors } from "../src/board/format";
import { describeChange } from "../src/board/panel/activity";
import { ANA, CALENDAR, FakeWebSocket, PROJECT_ID, projectState, section, task } from "./board-fixtures";
import { ADMIN, project, renderApp, screen, signedIn } from "./utils";

/** hooks: Fri Oct 9, 2 working days (Fri, Mon) — 32 px per day, weekends shown. */
const ROWS = [
  section("x", { position: "a0" }),
  task("hooks", { parentId: "x", position: "a0", userStart: "2026-10-09", duration: 2 }),
  task("ms", { parentId: "x", position: "a1", userStart: "2026-10-14", duration: 0 }),
  task("parent", { position: "b0" }),
  task("c1", { parentId: "parent", position: "a0", userStart: "2026-10-05", duration: 2, actualDuration: 2 }),
  task("c2", { parentId: "parent", position: "a1", userStart: "2026-10-05", duration: 1, actualDuration: 1.5 }),
];

async function board(rows: ProjectStateDto["rows"] = ROWS) {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const api = signedIn(ADMIN, [project(PROJECT_ID, "Launch")]);
  api.on(`GET /api/projects/${PROJECT_ID}/state`, () => ({ body: projectState(rows) }));
  api.on("GET /api/calendar", () => ({ body: CALENDAR }));
  api.on("GET /api/resources", () => ({ body: { resources: [ANA] } }));
  api.on(`GET /api/projects/${PROJECT_ID}/highlights`, () => ({ body: { highlights: [] } }));
  api.on(`GET /api/projects/${PROJECT_ID}/baselines`, () => ({ body: { baselines: [] } }));
  api.on(`GET /api/projects/${PROJECT_ID}/activity`, () => ({ body: { entries: [], nextBefore: null } }));
  api.on(`GET /api/projects/${PROJECT_ID}/comments`, () => ({ body: { comments: [], nextBefore: null } }));
  const app = renderApp(`/p/${PROJECT_ID}`);
  await screen.findByRole("treegrid", { name: "Tasks" });
  await waitFor(() => expect(FakeWebSocket.last.sent).toHaveLength(1));
  FakeWebSocket.last.deliver({ type: "joined", projectId: PROJECT_ID, version: 5, instanceVersion: 1, viewers: [] });
  return app;
}

const sentCommands = (): Command[] =>
  FakeWebSocket.last.sent.flatMap((message) => ((message as { type: string }).type === "command" ? [(message as { command: Command }).command] : []));
const listRow = (title: string) => screen.getAllByRole("row").find((row) => within(row).queryByText(title, { exact: true }))!;
/** A color as the browser reports it in a style attribute. */
const swatch = (color: string) => {
  const probe = document.createElement("div");
  probe.style.background = color;
  return probe.style.background;
};
const width = (element: Element) => parseFloat((element as HTMLElement).style.width);

describe("half days and actual work days", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 29, 12));
  });
  afterEach(() => vi.useRealTimers());

  it("takes half days as working days and draws the bar to the half column", async () => {
    const { user } = await board();
    await user.click(screen.getByRole("button", { name: "Working days of “hooks”" }));
    await user.keyboard("{Control>}a{/Control}2.5{Enter}");
    expect(sentCommands()).toEqual([{ type: "setDuration", id: "hooks", duration: 2.5 }]);
    // Fri 9 → Tue 13 fills 5 columns (weekend shown); the last one only half
    const bar = screen.getByRole("button", { name: /^hooks,/ });
    expect(width(bar)).toBe(5 * 32 - 16);
    expect(within(listRow("hooks")).getByRole("button", { name: "Working days of “hooks”" })).toHaveTextContent("2.5");
  });

  it("draws actual work days on the bar and as a track under it: red when over, green when under, grey on plan", async () => {
    for (const [actual, versusPlan, columns] of [
      [3, "over", 5], // Fri, (Sat, Sun), Mon, Tue: three working days
      [1.5, "under", 4 - 0.5], // Fri, (Sat, Sun), half of Mon
      [2, "even", 4],
    ] as const) {
      const { unmount } = await board(ROWS.map((row) => (row.id === "hooks" && row.kind === "task" ? { ...row, actualDuration: actual } : row)));
      const hooks = screen.getByRole("button", { name: new RegExp(`^hooks, .*took ${actual} of 2 working days$`) });
      const track = within(hooks.parentElement!).getByTestId("actual-track");
      expect(track).toHaveAttribute("data-versus-plan", versusPlan);
      expect(width(track)).toBe(columns * 32);
      // On the bar itself (planned: 4 columns): the overrun continues it (striped), unused days are dimmed.
      const over = within(hooks.parentElement!).queryByTestId("actual-over");
      const under = within(hooks.parentElement!).queryByTestId("actual-under");
      if (versusPlan === "over") expect(width(over!)).toBe((columns - 4) * 32);
      else expect(over).toBeNull();
      if (versusPlan === "under") expect(width(under!)).toBe((4 - columns) * 32);
      else expect(under).toBeNull();
      unmount();
    }
  });

  it("adds up a parent's actual days and never offers them on milestones", async () => {
    await board();
    expect(within(listRow("parent")).getByRole("gridcell", { name: "3.5 actual work days" })).toBeInTheDocument();
    expect(within(listRow("parent")).queryByRole("button", { name: /^Actual work days/ })).not.toBeInTheDocument();
    expect(within(listRow("ms")).queryByRole("button", { name: /^Actual work days/ })).not.toBeInTheDocument();
  });

  it("starts in the afternoon or ends at midday from the details panel, and draws it", async () => {
    const { user } = await board(ROWS.map((row) => (row.id === "hooks" && row.kind === "task" ? { ...row, startsAfternoon: true, duration: 1.5 } : row)));
    // Fri 9 afternoon → Mon 12 end of day: 1.5 working days; the bar starts mid-column
    const hooks = screen.getByRole("button", { name: /^hooks, .*\(afternoon\) – / });
    expect(width(hooks)).toBe(4 * 32 - 16);
    await user.dblClick(within(listRow("hooks")).getByRole("gridcell", { name: "Row 2" }));
    const panel = await screen.findByRole("complementary", { name: "Details of “hooks”" });
    const starts = within(panel).getByRole("group", { name: "Starts: morning or afternoon" });
    expect(within(starts).getByRole("button", { name: "Starts in the afternoon" })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(starts).getByRole("button", { name: "Starts in the morning" }));
    expect(sentCommands().at(-1)).toEqual({ type: "moveTask", id: "hooks", start: "2026-10-09", half: "morning" });
    // Now Fri morning → Mon midday; stretch it to the end of Monday
    const ends = within(panel).getByRole("group", { name: "Ends: morning or afternoon" });
    expect(within(ends).getByRole("button", { name: "Ends at midday" })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(ends).getByRole("button", { name: "Ends at the end of the day" }));
    expect(sentCommands().at(-1)).toEqual({ type: "resizeTask", id: "hooks", edge: "end", date: "2026-10-12", half: "afternoon" });
  });

  it("draws a parent in its own color: a bracket over its subtasks, a bar when collapsed", async () => {
    const { user } = await board(ROWS.map((row) => (row.id === "parent" && row.kind === "task" ? { ...row, color: "green" as const } : row)));
    const shape = () => screen.getByRole("button", { name: /^parent,/ });
    const green = swatch(taskColors("green").fill);
    expect(shape().style.background).toBe("");
    expect([...shape().children].map((part) => (part as HTMLElement).style.background)).toEqual([green, green, green]);
    await user.click(within(listRow("parent")).getByRole("button", { name: "Collapse" }));
    expect(shape().style.background).toBe(green);
  });

  it("records actual days in the details panel", async () => {
    const { user } = await board();
    await user.dblClick(within(listRow("hooks")).getByRole("gridcell", { name: "Row 2" }));
    const panel = await screen.findByRole("complementary", { name: "Details of “hooks”" });
    const field = within(panel).getByRole("spinbutton", { name: "Actual work days" });
    await user.type(field, "4.5{Enter}");
    expect(sentCommands().at(-1)).toEqual({ type: "setActualDuration", id: "hooks", days: 4.5 });
  });

  it("describes actual days in the history", () => {
    const names = { state: { rows: {} }, resources: new Map() };
    expect(describeChange({ rowId: "t", field: "actualDuration", before: null, after: 5 }, names)).toBe("recorded 5 actual work days");
    expect(describeChange({ rowId: "t", field: "actualDuration", before: 5, after: null }, names)).toBe("cleared its actual work days");
    expect(describeChange({ rowId: "t", field: "duration", before: 2, after: 2.5 }, names)).toBe("set it to 2.5 working days");
  });
});
