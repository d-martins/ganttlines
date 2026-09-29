import type { BoardRow } from "../model";
import type { BarStyle } from "../view-store";
import { extent, ROW_HEIGHT } from "./bars";
import type { Timeline } from "./timeline";

const STUB = 8;

/**
 * Elbow path from the end of a predecessor (row `from`) to the start of its successor (row `to`):
 * out to the right, down, and in from the left; when the successor starts too early for that,
 * it doubles back between the two rows.
 */
export function elbow(fromX: number, fromY: number, toX: number, toY: number, rowHeight: number): string {
  if (toX - STUB >= fromX + STUB) return `M${fromX},${fromY} H${fromX + STUB} V${toY} H${toX}`;
  const between = fromY + (toY > fromY ? rowHeight / 2 : -rowHeight / 2);
  return `M${fromX},${fromY} H${fromX + STUB} V${between} H${toX - STUB} V${toY} H${toX}`;
}

/** Dependency arrows between shown rows that touch the rendered window [firstRow, lastRow). */
export function Dependencies({
  rows,
  firstRow,
  lastRow,
  timeline,
  style,
}: {
  rows: readonly BoardRow[];
  firstRow: number;
  lastRow: number;
  timeline: Timeline;
  style: BarStyle;
}) {
  const rowHeight = ROW_HEIGHT[style];
  const index = new Map(rows.map((entry, i) => [entry.row.id, i]));
  const paths: { key: string; d: string; violation: boolean }[] = [];
  rows.forEach((entry, to) => {
    const { row } = entry;
    if (row.kind !== "task" || !row.predecessorId || !entry.span) return;
    const from = index.get(row.predecessorId);
    const predecessor = from === undefined ? undefined : rows[from];
    if (!predecessor?.span || Math.max(from!, to) < firstRow || Math.min(from!, to) >= lastRow) return;
    const start = extent(predecessor.kind, predecessor.span, timeline, style);
    const end = extent(entry.kind, entry.span, timeline, style);
    const y = (i: number) => i * rowHeight + rowHeight / 2;
    paths.push({ key: row.id, d: elbow(start.right, y(from!), end.left, y(to), rowHeight), violation: entry.violation });
  });
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
