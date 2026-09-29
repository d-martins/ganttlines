import { X } from "lucide-react";
import { create } from "zustand";

export interface Toast {
  id: number;
  message: string;
  tone: "info" | "error";
  action?: { label: string; run: () => void };
}

interface Toasts {
  toasts: Toast[];
  dismiss: (id: number) => void;
}

const TOAST_MS = 6000;
const MAX_TOASTS = 3;
let nextId = 1;

export const useToasts = create<Toasts>((set) => ({
  toasts: [],
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));

/** Shows a short message at the bottom of the screen (errors stay a little longer). */
export function toast(message: string, options: { tone?: Toast["tone"]; action?: Toast["action"] } = {}): void {
  const id = nextId++;
  const entry: Toast = { id, message, tone: options.tone ?? "info", ...(options.action ? { action: options.action } : {}) };
  useToasts.setState((state) => ({ toasts: [...state.toasts, entry].slice(-MAX_TOASTS) }));
  setTimeout(() => useToasts.getState().dismiss(id), entry.tone === "error" ? TOAST_MS * 1.5 : TOAST_MS);
}

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  return (
    <div aria-live="polite" className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((entry) => (
        <div
          key={entry.id}
          role={entry.tone === "error" ? "alert" : "status"}
          className="pointer-events-auto flex max-w-md items-center gap-3 rounded-md bg-text px-3 py-2 text-sm text-bg shadow-lg"
        >
          <span className={entry.tone === "error" ? "font-medium" : ""}>{entry.message}</span>
          {entry.action ? (
            <button
              type="button"
              className="font-semibold underline"
              onClick={() => {
                entry.action!.run();
                dismiss(entry.id);
              }}
            >
              {entry.action.label}
            </button>
          ) : null}
          <button type="button" aria-label="Dismiss" className="opacity-70 hover:opacity-100" onClick={() => dismiss(entry.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
