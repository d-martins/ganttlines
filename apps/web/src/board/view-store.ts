import { create } from "zustand";
import { isBoolean, readPref, writePref } from "../storage";
import type { Zoom } from "./chart/timeline";

export type BarStyle = "compact" | "roomy";

interface BoardView {
  zoom: Zoom;
  barStyle: BarStyle;
  showWeekends: boolean;
  listWidth: number;
  /** bumped to ask the chart to scroll to today */
  todayRequest: number;
  setZoom: (zoom: Zoom) => void;
  setBarStyle: (style: BarStyle) => void;
  setShowWeekends: (show: boolean) => void;
  setListWidth: (width: number) => void;
  goToToday: () => void;
}

const isZoom = (value: unknown): value is Zoom => value === "day" || value === "week" || value === "month";
const isBarStyle = (value: unknown): value is BarStyle => value === "compact" || value === "roomy";
const isWidth = (value: unknown): value is number => typeof value === "number" && value >= LIST_WIDTH.min && value <= LIST_WIDTH.max;

/** `min` fits every list column (see COLUMNS in list/task-list.tsx: 392 px of columns + 8 px padding). */
export const LIST_WIDTH = { min: 400, max: 900, initial: 460 } as const;

/** How this browser likes to look at boards (web spec §2): remembered per browser, not per project. */
export const useBoardView = create<BoardView>((set) => ({
  zoom: readPref("zoom", "day", isZoom),
  barStyle: readPref("barStyle", "compact", isBarStyle),
  showWeekends: readPref("showWeekends", true, isBoolean),
  listWidth: readPref("listWidth", LIST_WIDTH.initial, isWidth),
  todayRequest: 0,
  setZoom: (zoom) => {
    writePref("zoom", zoom);
    set({ zoom });
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
