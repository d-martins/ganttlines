/** Dragging within this many pixels of the board's visible edge (or past it) scrolls it. */
const AUTO_SCROLL_EDGE = 40;
/** fastest auto-scroll, in pixels per tick (reached at the edge and beyond) */
export const AUTO_SCROLL_STEP = 24;
export const AUTO_SCROLL_TICK_MS = 16;
/** height of the sticky header above the rows */
export const HEADER_HEIGHT = 48;

/** How hard to scroll for a pointer at `position` given the visible range [start, end]: -1…1. */
export function edgePush(position: number, start: number, end: number): number {
  if (position > end - AUTO_SCROLL_EDGE) return Math.min((position - (end - AUTO_SCROLL_EDGE)) / AUTO_SCROLL_EDGE, 1);
  if (position < start + AUTO_SCROLL_EDGE) return -Math.min((start + AUTO_SCROLL_EDGE - position) / AUTO_SCROLL_EDGE, 1);
  return 0;
}
