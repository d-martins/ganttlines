import { create } from "zustand";
import { isBoolean, readPref, writePref } from "../storage";

interface SidebarState {
  collapsed: boolean;
  toggle: () => void;
}

/** Whether the project sidebar is collapsed to its icon rail (remembered per browser). */
export const useSidebar = create<SidebarState>((set, get) => ({
  collapsed: readPref("sidebarCollapsed", false, isBoolean),
  toggle: () => {
    const collapsed = !get().collapsed;
    writePref("sidebarCollapsed", collapsed);
    set({ collapsed });
  },
}));
