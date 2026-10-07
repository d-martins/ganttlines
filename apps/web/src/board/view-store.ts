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

/** `min` fits every list column (see COLUMNS in list/task-list.tsx: 420 px of columns + 8 px padding). */
export const LIST_WIDTH = { min: 448, max: 900, initial: 500 } as const;

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
