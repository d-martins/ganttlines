import { useLayoutEffect, type RefObject } from "react";

const MAX_LIST_HEIGHT = 288;
const LIST_GAP = 4;
const LIST_MARGIN = 8;

/** Floats the list by the box without leaving the window: under it, or above it if there's more room. */
export function placeSuggestions(box: HTMLElement, list: HTMLElement) {
  const scrolled = list.scrollTop;
  // `fixed` is relative to the window, unless something holding the list has a transform, as a menu
  // does: placed at 0,0 it shows where that frame starts.
  Object.assign(list.style, { left: "0px", top: "0px", maxHeight: "none" });
  const frame = list.getBoundingClientRect();
  const anchor = box.getBoundingClientRect();
  const below = window.innerHeight - anchor.bottom - LIST_GAP - LIST_MARGIN;
  const above = anchor.top - LIST_GAP - LIST_MARGIN;
  const height = Math.min(frame.height, MAX_LIST_HEIGHT);
  const under = height <= below || below >= above;
  const shown = Math.min(height, under ? below : above);
  const left = Math.min(anchor.left, window.innerWidth - frame.width - LIST_MARGIN);
  const top = under ? anchor.bottom + LIST_GAP : anchor.top - LIST_GAP - shown;
  Object.assign(list.style, { left: `${left - frame.left}px`, top: `${top - frame.top}px`, maxHeight: `${Math.min(MAX_LIST_HEIGHT, under ? below : above)}px` });
  list.scrollTop = scrolled;
}

/** Keeps a `fixed` list by its box. After every render, as the box can move and typing changes the list's height. */
export function useFloatingList(open: boolean, box: RefObject<HTMLElement | null>, list: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => box.current && list.current && placeSuggestions(box.current, list.current);
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  });
}
