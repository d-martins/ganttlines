import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { useCollapse } from "../src/board/collapse";
import { initialBoardView, useBoardView } from "../src/board/view-store";
import { resetSelection } from "../src/board/selection";
import { useToasts } from "../src/ui/toast";

afterEach(() => {
  cleanup();
  // App-wide stores outlive a render: start every test clean.
  useToasts.setState({ toasts: [] });
  resetSelection();
  useCollapse.setState({ byProject: {} });
  localStorage.clear();
  useBoardView.setState(initialBoardView());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// jsdom has no matchMedia; the theme code asks whether the OS prefers dark.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

// jsdom has no ResizeObserver; the board measures its scroll area with one.
if (typeof window.ResizeObserver === "undefined") {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// jsdom has no layout; ProseMirror (the rich-text editor) measures selections with these.
if (typeof document.elementFromPoint !== "function") document.elementFromPoint = () => null;
const noRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects = noRects;
Range.prototype.getBoundingClientRect = () => new DOMRect();
