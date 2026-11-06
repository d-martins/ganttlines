import { fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Calendar, type ProjectState } from "@ganttlines/engine";
import { useChartDrag } from "../src/board/chart/drag";
import { optionsFor } from "../src/board/chart/link-choice";
import { FakeWebSocket, task } from "./board-fixtures";
import { board, sentCommands } from "./chart-board";
import { screen, VIEWER } from "./utils";

const cal = new Calendar({ workingWeekdays: [1, 2, 3, 4, 5], holidays: [], timeOff: [] });
const rowsOf = (...rows: ReturnType<typeof task>[]): ProjectState => ({ rows: Object.fromEntries(rows.map((row) => [row.id, row])), links: {} });
const hotfix = () => task("hotfix", { title: "Hotfix", position: "a0", userStart: "2026-10-13", duration: 3 });
const login = () => task("login", { title: "Fix login", position: "a1", userStart: "2026-10-12", duration: 2 });
const cutoff = () => task("cutoff", { title: "8.10", position: "a2", userStart: "2026-10-23", duration: 0 });

describe("optionsFor", () => {
  it("reads from the task dragged: the four links as sentences, then the interruption", () => {
    const options = optionsFor(rowsOf(hotfix(), login()), cal, "hotfix", "login");
    expect(options.map((option) => option.label)).toEqual([
      "Hotfix starts after Fix login finishes",
      "Hotfix starts when Fix login starts",
      "Hotfix finishes when Fix login finishes",
      "Hotfix finishes when Fix login starts",
      "Hotfix interrupts Fix login",
    ]);
    expect(options[4]).toMatchObject({ note: "Fix login stops while Hotfix runs", command: { type: "addInterruption", id: "login", byId: "hotfix" } });
    expect(options[0]!.command).toEqual({ type: "addLink", predecessorId: "login", followerId: "hotfix", kind: "FS" });
    expect(options[3]!.command).toEqual({ type: "addLink", predecessorId: "login", followerId: "hotfix", kind: "SF" });
  });

  it("the other way round rereads every line", () => {
    expect(optionsFor(rowsOf(hotfix(), login()), cal, "login", "hotfix").map((option) => option.label)).toEqual([
      "Fix login starts after Hotfix finishes",
      "Fix login starts when Hotfix starts",
      "Fix login finishes when Hotfix finishes",
      "Fix login finishes when Hotfix starts",
      "Fix login interrupts Hotfix",
    ]);
  });

  it("a task and a milestone: aiming first, nothing to interrupt", () => {
    const options = optionsFor(rowsOf(login(), cutoff()), cal, "login", "cutoff");
    expect(options[0]).toMatchObject({ label: "Fix login aims for 8.10", note: "Never moves the milestone", command: { type: "setTarget", id: "login", targetId: "cutoff" } });
    expect(options[1]).toMatchObject({ label: "Fix login starts after 8.10 finishes" });
    expect(options[1]).not.toHaveProperty("note");
    expect(optionsFor(rowsOf(login(), cutoff()), cal, "cutoff", "login")[1]).toMatchObject({ label: "8.10 starts after Fix login finishes", note: "The milestone moves if Fix login is late" });
    expect(options.some((option) => /interrupts/.test(option.label))).toBe(false);
    expect(optionsFor(rowsOf(login(), cutoff()), cal, "cutoff", "login")[0]).toMatchObject({ label: "Fix login aims for 8.10" });
  });

  it("says when aiming would replace another aim", () => {
    const options = optionsFor(rowsOf(task("login", { title: "Fix login", userStart: "2026-10-12", targetId: "other" }), cutoff(), task("other", { title: "8.11", userStart: "2026-10-30", duration: 0 })), cal, "login", "cutoff");
    expect(options[0]!.note).toBe("Instead of 8.11");
  });

  it("marks what the board would refuse, with why", () => {
    const state = rowsOf(hotfix(), task("login", { title: "Fix login", position: "a1", userStart: "2026-10-12", duration: 2, interruptedBy: ["hotfix"] }));
    const options = optionsFor(state, cal, "hotfix", "login");
    expect(options.at(-1)!.refused).toBe("That task already interrupts this one");
    expect(options[0]!.refused).toBe("That would create a dependency cycle"); // Fix login already stops for Hotfix
    expect(optionsFor(state, cal, "login", "hotfix")[0]!.refused).toBeUndefined();
  });

  it("stays quick on a large board", () => {
    const many = Array.from({ length: 2000 }, (_, i) => task(`t${i}`, { position: `a${i}`, userStart: "2026-10-12", duration: 3 }));
    const state = rowsOf(hotfix(), login(), ...many);
    const before = Date.now();
    optionsFor(state, cal, "hotfix", "login");
    expect(Date.now() - before).toBeLessThan(2000);
  });
});

describe("the one handle and the menu", () => {
  const handleOf = (name: string) => within(screen.getByRole("button", { name: new RegExp(`^${name}, `) }).parentElement!).getByTitle("Drag onto another task to link them");
  const dropOn = (name: string, row: number) => {
    fireEvent.pointerDown(handleOf(name), { button: 0, clientX: 500, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 700, clientY: row * 30 + 15 });
    fireEvent.pointerUp(window, { clientX: 900, clientY: row * 30 + 15 });
  };
  const items = () => screen.getAllByRole("menuitem");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 1, 12));
  });
  afterEach(() => {
    vi.useRealTimers();
    useChartDrag.setState({ drag: null });
  });

  it("each bar has one handle, at its end", async () => {
    await board([hotfix(), login()]);
    const shape = screen.getByRole("button", { name: /^Hotfix, / });
    expect(within(shape.parentElement!).queryByTitle(/from the start/)).not.toBeInTheDocument();
    expect(parseFloat(handleOf("Hotfix").style.left)).toBeGreaterThan(parseFloat(shape.style.left));
  });

  it("viewers don't get one", async () => {
    await board([hotfix(), login()], VIEWER);
    expect(screen.queryByTitle("Drag onto another task to link them")).not.toBeInTheDocument();
  });

  it("dropping on another task opens the menu, sends nothing, with the direction dragged", async () => {
    await board([hotfix(), login()]);
    dropOn("Hotfix", 1);
    expect(await screen.findByRole("menu", { name: "Link Hotfix and Fix login" })).toBeInTheDocument();
    expect(items()[1]).toHaveTextContent("Hotfix starts after Fix login finishes"); // after Swap
    expect(sentCommands()).toEqual([]);
  });

  it("dropping on nothing does nothing", async () => {
    await board([hotfix(), login()]);
    dropOn("Hotfix", 9);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("Enter takes the first link", async () => {
    const user = userEvent.setup();
    await board([hotfix(), login()]);
    dropOn("Hotfix", 1);
    await screen.findByRole("menu");
    await waitFor(() => expect(items()[1]).toHaveFocus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(sentCommands().at(-1)).toEqual({ type: "addLink", predecessorId: "login", followerId: "hotfix", kind: "FS" }));
  });

  it("Swap flips the direction", async () => {
    const user = userEvent.setup();
    await board([hotfix(), login()]);
    dropOn("Hotfix", 1);
    await user.click(await screen.findByRole("menuitem", { name: /Swap/ }));
    expect(items()[1]).toHaveTextContent("Fix login starts after Hotfix finishes");
    await user.click(items()[1]!);
    await waitFor(() => expect(sentCommands().at(-1)).toEqual({ type: "addLink", predecessorId: "hotfix", followerId: "login", kind: "FS" }));
  });

  it("a refused option is disabled and says why", async () => {
    await board([hotfix(), task("login", { title: "Fix login", position: "a1", userStart: "2026-10-12", duration: 2, interruptedBy: ["hotfix"] })]);
    dropOn("Hotfix", 1);
    await screen.findByRole("menu");
    const option = screen.getByRole("menuitem", { name: /Hotfix interrupts Fix login/ });
    expect(option).toHaveAttribute("aria-disabled", "true");
    expect(option).toHaveTextContent("That task already interrupts this one");
  });

  it("pointing at an option shows it on the board; opening alone doesn't, and leaving puts it back", async () => {
    await board([hotfix(), login()]);
    dropOn("Hotfix", 1);
    await screen.findByRole("menu");
    const trigger = screen.getByLabelText("Link Hotfix and Fix login");
    const position = [trigger.style.left, trigger.style.top];
    await waitFor(() => expect(items()[1]).toHaveFocus());
    expect(useChartDrag.getState().drag).toBeNull();
    const option = screen.getByRole("menuitem", { name: /Hotfix interrupts Fix login/ });
    // Radix focuses an item as the pointer moves over it, before the move reaches the menu.
    const first = items()[1]!;
    fireEvent.pointerMove(first);
    expect(useChartDrag.getState().drag?.command).toEqual({ type: "addLink", predecessorId: "login", followerId: "hotfix", kind: "FS" });
    fireEvent.pointerMove(option);
    expect(useChartDrag.getState().drag?.command).toEqual({ type: "addInterruption", id: "login", byId: "hotfix" });
    expect([trigger.style.left, trigger.style.top]).toEqual(position);
    fireEvent.blur(option);
    expect(useChartDrag.getState().drag).toBeNull();
    fireEvent.pointerMove(option);
    fireEvent.focus(option);
    fireEvent.keyDown(option, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(useChartDrag.getState().drag).toBeNull();
    expect(sentCommands()).toEqual([]);
  });

  it("Cmd+Z does nothing while it's open", async () => {
    await board([hotfix(), login()]);
    dropOn("Hotfix", 1);
    await screen.findByRole("menu");
    const sent = FakeWebSocket.last.sent.length;
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(FakeWebSocket.last.sent).toHaveLength(sent);
  });

  it("the arrow keys show it too", async () => {
    const user = userEvent.setup();
    await board([hotfix(), login()]);
    dropOn("Hotfix", 1);
    await screen.findByRole("menu");
    await waitFor(() => expect(items()[1]).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(useChartDrag.getState().drag?.command).toEqual({ type: "addLink", predecessorId: "login", followerId: "hotfix", kind: "SS" }));
  });
});
