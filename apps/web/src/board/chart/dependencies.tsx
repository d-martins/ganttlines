import { linkKey, type LinkKind } from "@ganttlines/engine";
import type { BoardModel, BoardRow } from "../model";
import type { BarStyle } from "../view-store";
import { extent, halfHeight, shapeOf, ROW_HEIGHT } from "./bars";
import type { Timeline } from "./timeline";

const STUB = 8;

/**
 * Path from a predecessor to its successor: down (or up) out of the predecessor's bottom (or top)
 * edge, then across into the successor's left side. The drop sits near the predecessor's end, but
 * always far enough left to arrive from the left; when the successor starts too early for that,
 * the path runs between the rows and comes back round.
 */
export function elbow(from: { left: number; right: number; y: number; half: number }, to: { left: number; y: number }, rowHeight: number): string {
  const down = to.y >= from.y;
  const startY = down ? from.y + from.half : from.y - from.half;
  const center = (from.left + from.right) / 2;
  // Near the end of the bar (the middle of short bars and diamonds), but left of the successor.
  const x = Math.min(Math.max(from.right - STUB, center), to.left - STUB);
  if (x >= from.left + 2) return `M${x},${startY} V${to.y} H${to.left}`;
  const between = from.y + (down ? rowHeight / 2 : -rowHeight / 2);
  return `M${center},${startY} V${between} H${to.left - STUB} V${to.y} H${to.left}`;
}

/**
 * Path of a link of `kind` from its predecessor to its follower. FS is the elbow into the follower's
 * start. SS leaves the predecessor's start, passes left of both bars and enters the follower's start
 * (pointing right); FF leaves the predecessor's end, passes right of both and enters the follower's
 * end (pointing left).
 */
export function linkPath(
  kind: LinkKind,
  from: { left: number; right: number; y: number; half: number },
  to: { left: number; right: number; y: number },
  rowHeight: number,
): string {
  if (kind === "FS") return elbow(from, to, rowHeight);
  if (kind === "SS") return `M${from.left},${from.y} H${Math.min(from.left, to.left) - STUB} V${to.y} H${to.left}`;
  return `M${from.right},${from.y} H${Math.max(from.right, to.right) + STUB} V${to.y} H${to.right}`;
}

/** Dependency arrows between shown rows that touch the rendered window [firstRow, lastRow). */
export function Dependencies({
  rows,
  links,
  firstRow,
  lastRow,
  timeline,
  style,
}: {
  rows: readonly BoardRow[];
  links: BoardModel["links"];
  firstRow: number;
  lastRow: number;
  timeline: Timeline;
  style: BarStyle;
}) {
  const rowHeight = ROW_HEIGHT[style];
  const index = new Map(rows.map((entry, i) => [entry.row.id, i]));
  const paths: { key: string; d: string; violation: boolean }[] = [];
  for (const { link, violation } of links) {
    const from = index.get(link.predecessorId);
    const to = index.get(link.followerId);
    if (from === undefined || to === undefined) continue;
    const predecessor = rows[from]!;
    const entry = rows[to]!;
    if (!predecessor.span || !entry.span || Math.max(from, to) < firstRow || Math.min(from, to) >= lastRow) continue;
    const start = extent(predecessor.kind, predecessor.span, timeline, style);
    const end = extent(entry.kind, entry.span, timeline, style);
    const y = (i: number) => i * rowHeight + rowHeight / 2;
    const d = linkPath(link.kind, { ...start, y: y(from), half: halfHeight(shapeOf(predecessor), style) }, { ...end, y: y(to) }, rowHeight);
    paths.push({ key: linkKey(link), d, violation });
  }
  return (
    <svg aria-hidden className="pointer-events-none absolute top-0 left-0 overflow-visible" width={timeline.width} height={rows.length * rowHeight}>
      <defs>
        <marker id="dep-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L6,3 L0,6 z" fill="var(--dependency)" />
        </marker>
        <marker id="dep-arrow-violation" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L6,3 L0,6 z" fill="var(--violation)" />
        </marker>
      </defs>
      {paths.map((path) => (
        <path
          key={path.key}
          data-testid="dependency"
          data-violation={path.violation || undefined}
          d={path.d}
          fill="none"
          stroke={path.violation ? "var(--violation)" : "var(--dependency)"}
          strokeWidth={1.25}
          markerEnd={`url(#${path.violation ? "dep-arrow-violation" : "dep-arrow"})`}
        />
      ))}
    </svg>
  );
}
