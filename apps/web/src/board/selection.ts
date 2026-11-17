import { create } from "zustand";
import { isBoolean, readPref, writePref } from "../storage";

interface Selection {
  /** the focused row (list highlight, chart outline) */
  selectedId: string | null;
  /** the row whose title is being typed */
  editingId: string | null;
  /** a row created by this person that is still untitled: dropped again if they cancel */
  draftId: string | null;
  /** the details drawer is open, not collapsed to its strip (remembered per browser); while open it follows the selection */
  panelOpen: boolean;
  /** a request to scroll the chart to this row's bar (`seq` makes repeats count) */
  centerRequest: { id: string; seq: number } | null;
  /** selects a row; `openPanel` also opens the drawer on it */
  select: (id: string | null, openPanel?: boolean) => void;
  edit: (id: string | null, draft?: boolean) => void;
  /** collapses the drawer to its strip */
  closePanel: () => void;
  /** opens the drawer on the selected row */
  openPanel: () => void;
  center: (id: string) => void;
}

const DRAWER_OPEN = "detailsOpen";

/** One board is open at a time, so its selection is a single store (reset when a board opens). */
export const useSelection = create<Selection>((set) => ({
  selectedId: null,
  editingId: null,
  draftId: null,
  panelOpen: readPref(DRAWER_OPEN, false, isBoolean),
  centerRequest: null,
  select: (selectedId, openPanel = true) =>
    set((state) => {
      if (selectedId !== null && openPanel && !state.panelOpen) writePref(DRAWER_OPEN, true);
      return { selectedId, panelOpen: selectedId !== null && openPanel ? true : state.panelOpen };
    }),
  edit: (editingId, draft = false) =>
    set((state) => ({ editingId, selectedId: editingId ?? state.selectedId, draftId: draft ? editingId : editingId === null ? null : state.draftId })),
  closePanel: () => {
    writePref(DRAWER_OPEN, false);
    set({ panelOpen: false });
  },
  openPanel: () => {
    writePref(DRAWER_OPEN, true);
    set({ panelOpen: true });
  },
  center: (id) => set((state) => ({ centerRequest: { id, seq: (state.centerRequest?.seq ?? 0) + 1 } })),
}));

export const resetSelection = () => useSelection.setState({ selectedId: null, editingId: null, draftId: null, panelOpen: readPref(DRAWER_OPEN, false, isBoolean), centerRequest: null });
