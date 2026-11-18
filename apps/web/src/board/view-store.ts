import { create } from "zustand";
import { isBoolean, readPref, writePref } from "../storage";
import { DAY_WIDTH, ZOOM_STEPS, type Zoom } from "./chart/timeline";

export type BarStyle = "compact" | "roomy";

interface BoardView {
  /** a day's width in px: one of ZOOM_STEPS */
  dayWidth: number;
  barStyle: BarStyle;
  showWeekends: boolean;
  listWidth: number;
  /** bumped to ask the chart to scroll to today */
  todayRequest: number;
  setDayWidth: (dayWidth: number) => void;
  setBarStyle: (style: BarStyle) => void;
  setShowWeekends: (show: boolean) => void;
  setListWidth: (width: number) => void;
  goToToday: () => void;
}

const isZoom = (value: unknown): value is Zoom => value === "day" || value === "week" || value === "month";
const isBarStyle = (value: unknown): value is BarStyle => value === "compact" || value === "roomy";
const isWidth = (value: unknown): value is number => typeof value === "number" && value >= LIST_WIDTH.min && value <= LIST_WIDTH.max;

/** Narrower than its columns, the list scrolls sideways (see listContentWidth); it starts wide enough for them. */
export const LIST_WIDTH = { min: 240, max: 900, initial: 540 } as const;
/** What the "Can slip" column adds to the list while Critical path is on. */
export const SLIP_COLUMN = 72;
/** The row actions column: room for `count` icon buttons (14 px, 4 px apart) after an 8 px gap. */
export const rowActionsWidth = (count: number) => count * 14 + (count - 1) * 4 + 8;
/**
 * The most actions any row shows: "show on the chart" always, "expand / collapse all inside" on a row with nested rows
 * inside (a row two levels down exists), and "delete" for editors.
 */
export function mostRowActions(rows: readonly { id: string; parentId: string | null }[], canEdit: boolean): number {
  const parentOf = new Map(rows.map((row) => [row.id, row.parentId]));
  const nested = rows.some((row) => row.parentId !== null && (parentOf.get(row.parentId) ?? null) !== null);
  return 1 + (nested ? 1 : 0) + (canEdit ? 1 : 0);
}
/** The width the list's columns take, the task name at its least (COLUMNS in list/task-list.tsx, plus 8 px padding). */
export const listContentWidth = (critical: boolean, actions = 3) => 40 + 200 + 120 + 40 + 40 + rowActionsWidth(actions) + 8 + (critical ? SLIP_COLUMN : 0);

const isStep = (value: unknown): value is number => typeof value === "number" && (ZOOM_STEPS as readonly number[]).includes(value);

/** The view as stored in this browser (the zoom chosen before zoom steps existed counts as its preset). */
export const initialBoardView = () => ({
  dayWidth: readPref("dayWidth", DAY_WIDTH[readPref<Zoom>("zoom", "day", isZoom)], isStep),
  barStyle: readPref<BarStyle>("barStyle", "compact", isBarStyle),
  showWeekends: readPref("showWeekends", true, isBoolean),
  listWidth: readPref("listWidth", LIST_WIDTH.initial, isWidth),
  todayRequest: 0,
});

/** How this browser likes to look at boards: remembered per browser, not per project. */
export const useBoardView = create<BoardView>((set) => ({
  ...initialBoardView(),
  setDayWidth: (dayWidth) => {
    writePref("dayWidth", dayWidth);
    set({ dayWidth });
  },
  setBarStyle: (barStyle) => {
    writePref("barStyle", barStyle);
    set({ barStyle });
  },
  setShowWeekends: (showWeekends) => {
    writePref("showWeekends", showWeekends);
    set({ showWeekends });
  },
  setListWidth: (width) => {
    const listWidth = Math.round(Math.min(Math.max(width, LIST_WIDTH.min), LIST_WIDTH.max));
    writePref("listWidth", listWidth);
    set({ listWidth });
  },
  goToToday: () => set((state) => ({ todayRequest: state.todayRequest + 1 })),
}));
