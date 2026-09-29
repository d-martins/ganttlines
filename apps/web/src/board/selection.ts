import { create } from "zustand";

interface Selection {
  /** the focused row (list highlight, chart outline) */
  selectedId: string | null;
  /** the row whose title is being typed */
  editingId: string | null;
  /** a row created by this person that is still untitled: dropped again if they cancel */
  draftId: string | null;
  /** the details panel is open: selecting a row opens it (and retargets it); × / Escape close it */
  panelOpen: boolean;
  /** a request to scroll the chart so this row's bar is centered (`seq` makes repeats count) */
  centerRequest: { id: string; seq: number } | null;
  /** selects a row; list selections open the panel, chart ones only retarget it when already open */
  select: (id: string | null, openPanel?: boolean) => void;
  edit: (id: string | null, draft?: boolean) => void;
  closePanel: () => void;
  center: (id: string) => void;
}

/** One board is open at a time, so its selection is a single store (reset when a board opens). */
export const useSelection = create<Selection>((set) => ({
  selectedId: null,
  editingId: null,
  draftId: null,
  panelOpen: false,
  centerRequest: null,
  select: (selectedId, openPanel = true) => set((state) => ({ selectedId, panelOpen: selectedId !== null && openPanel ? true : state.panelOpen })),
  edit: (editingId, draft = false) =>
    set((state) => ({ editingId, selectedId: editingId ?? state.selectedId, draftId: draft ? editingId : editingId === null ? null : state.draftId })),
  closePanel: () => set({ panelOpen: false }),
  center: (id) => set((state) => ({ centerRequest: { id, seq: (state.centerRequest?.seq ?? 0) + 1 } })),
}));

export const resetSelection = () => useSelection.setState({ selectedId: null, editingId: null, draftId: null, panelOpen: false, centerRequest: null });
