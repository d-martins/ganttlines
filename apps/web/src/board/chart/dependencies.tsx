import { useCriticalLinks } from "../slack";
import { linkKey, type LinkKind } from "@ganttlines/engine";
import type { BoardModel, BoardRow } from "../model";
import type { BarStyle } from "../view-store";
import { extent, halfHeight, shapeOf, ROW_HEIGHT } from "./bars";
import { useHoveredRow } from "./drag";
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
 * end (pointing left). SF leaves the predecessor's start and enters the follower's end (pointing left),
 * running between the rows and round the follower's end unless that end is well left of the start.
 * Arrows are drawn under the rows, so a start dot shown on hover covers its line.
 */
export function linkPath(
  kind: LinkKind,
  from: { left: number; right: number; y: number; half: number },
  to: { left: number; right: number; y: number },
  rowHeight: number,
): string {
  if (kind === "FS") return elbow(from, to, rowHeight);
  if (kind === "SS") return `M${from.left},${from.y} H${Math.min(from.left, to.left) - STUB} V${to.y} H${to.left}`;
  if (kind === "SF") {
    const out = from.left - STUB;
    if (to.right + STUB <= out) return `M${from.left},${from.y} H${out} V${to.y} H${to.right}`;
    const between = from.y + (to.y >= from.y ? rowHeight / 2 : -rowHeight / 2);
    return `M${from.left},${from.y} H${out} V${between} H${to.right + STUB} V${to.y} H${to.right}`;
  }
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
  const critical = useCriticalLinks();
  const index = new Map(rows.map((entry, i) => [entry.row.id, i]));
  const hovered = useHoveredRow((store) => store.id);
  const interruptions: { key: string; d: string }[] = [];
  if (hovered !== null) {
    rows.forEach((entry, to) => {
      if (entry.row.kind !== "task" || !entry.span) return;
      for (const byId of entry.row.interruptedBy ?? []) {
        if (hovered !== byId && hovered !== entry.row.id) continue;
        const from = index.get(byId);
        const by = from === undefined ? undefined : rows[from];
        if (from === undefined || !by?.span) continue;
        const y = (i: number) => i * rowHeight + rowHeight / 2;
        const direction = to >= from ? 1 : -1;
        const top = y(from) + direction * halfHeight(shapeOf(by), style);
        const bottom = y(to) - direction * halfHeight(shapeOf(entry), style);
        const line = (x: number, end: string) => interruptions.push({ key: `${byId}-${entry.row.id}-${x}-${end}`, d: `M${x},${top} V${bottom}` });
        const boxes = entry.parts.map((part) => extent(entry.kind, part, timeline, style));
        // Down each edge of a gap to what's running in it: a pair for each part of the interrupting task.
        boxes.slice(1).forEach((after, i) => {
          const gap = { left: boxes[i]!.right, right: after.left };
          for (const part of by.parts) {
            const box = extent(by.kind, part, timeline, style);
            if (box.right <= gap.left || box.left >= gap.right) continue;
            line(Math.max(box.left, gap.left), "start");
            line(Math.min(box.right, gap.right), "end");
          }
        });
      }
    });
  }
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
        <marker id="dep-arrow-critical" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L6,3 L0,6 z" fill="var(--slack-zero)" />
        </marker>
        <marker id="dep-arrow-violation" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L6,3 L0,6 z" fill="var(--violation)" />
        </marker>
      </defs>
      {interruptions.map((path) => (
        <path key={path.key} data-testid="interruption" d={path.d} fill="none" stroke="var(--dependency)" strokeWidth={1.25} strokeDasharray="4 3" />
      ))}
      {paths.map((path) => (
        <path
          key={path.key}
          data-testid="dependency"
          data-violation={path.violation || undefined}
          data-critical={critical.has(path.key) || undefined}
          d={path.d}
          fill="none"
          stroke={path.violation ? "var(--violation)" : critical.has(path.key) ? "var(--slack-zero)" : "var(--dependency)"}
          strokeWidth={1.25}
          markerEnd={`url(#${path.violation ? "dep-arrow-violation" : critical.has(path.key) ? "dep-arrow-critical" : "dep-arrow"})`}
        />
      ))}
    </svg>
  );
}
