import { create } from "zustand";

interface Selection {
  /** the focused row (list highlight, chart outline) */
  selectedId: string | null;
  /** the row whose title is being typed */
  editingId: string | null;
  /** a row created by this person that is still untitled: dropped again if they cancel */
  draftId: string | null;
  select: (id: string | null) => void;
  edit: (id: string | null, draft?: boolean) => void;
}

/** One board is open at a time, so its selection is a single store (reset when a board opens). */
export const useSelection = create<Selection>((set) => ({
  selectedId: null,
  editingId: null,
  draftId: null,
  select: (selectedId) => set({ selectedId }),
  edit: (editingId, draft = false) =>
    set((state) => ({ editingId, selectedId: editingId ?? state.selectedId, draftId: draft ? editingId : editingId === null ? null : state.draftId })),
}));

export const resetSelection = () => useSelection.setState({ selectedId: null, editingId: null, draftId: null });
