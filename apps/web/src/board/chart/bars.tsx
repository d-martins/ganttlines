import type { ResourceDto } from "@ganttlines/protocol";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Lock } from "lucide-react";
import type { Span } from "@ganttlines/engine";
import { Avatar } from "../../ui/avatar";
import { formatDay, taskColors } from "../format";
import type { BoardRow, DrawKind, Ghost } from "../model";
import type { BarStyle } from "../view-store";
import type { Timeline } from "./timeline";

export const ROW_HEIGHT: Record<BarStyle, number> = { compact: 30, roomy: 40 };
const BAR_HEIGHT: Record<BarStyle, number> = { compact: 14, roomy: 28 };
const DIAMOND: Record<BarStyle, number> = { compact: 12, roomy: 16 };

/** Horizontal extent of a drawn row: bars span their days; a milestone is a diamond on its day. */
export function extent(kind: DrawKind | Ghost["kind"], span: Span, timeline: Timeline, style: BarStyle): { left: number; right: number } {
  if (kind === "milestone") {
    const center = timeline.x(span.start) + timeline.dayWidth / 2;
    return { left: center - DIAMOND[style] / 2, right: center + DIAMOND[style] / 2 };
  }
  return { left: timeline.x(span.start), right: Math.max(timeline.xEnd(span.end), timeline.x(span.start) + 2) };
}

/** "Oct 5 – Oct 9, Ana" */
export function barDetails(span: Span, assignee: string | undefined): string {
  const dates = span.start === span.end ? formatDay(span.start) : `${formatDay(span.start)} – ${formatDay(span.end)}`;
  return assignee ? `${dates}, ${assignee}` : dates;
}

/** Bars, brackets, diamonds and baseline ghosts for the rendered rows. */
export function Bars({
  rows,
  firstRow,
  timeline,
  style,
  resources,
}: {
  rows: readonly BoardRow[];
  firstRow: number;
  timeline: Timeline;
  style: BarStyle;
  resources: ReadonlyMap<string, ResourceDto>;
}) {
  const rowHeight = ROW_HEIGHT[style];
  return (
    <>
      {rows.map((entry, index) => {
        const top = (firstRow + index) * rowHeight;
        return (
          <div key={entry.row.id} className="absolute left-0" style={{ top, height: rowHeight }}>
            {entry.ghost ? <GhostBar ghost={entry.ghost} timeline={timeline} style={style} /> : null}
            {entry.span ? <RowBar entry={entry} span={entry.span} timeline={timeline} style={style} resources={resources} /> : null}
          </div>
        );
      })}
    </>
  );
}

function GhostBar({ ghost, timeline, style }: { ghost: Ghost; timeline: Timeline; style: BarStyle }) {
  const { left, right } = extent(ghost.kind, ghost.span, timeline, style);
  const rowHeight = ROW_HEIGHT[style];
  if (ghost.kind === "milestone") {
    const size = DIAMOND[style] * 0.7;
    return (
      <div
        data-testid="baseline-ghost"
        className="absolute rotate-45 border-2 border-[var(--baseline)]"
        style={{ left: (left + right) / 2 - size / 2, top: rowHeight - size - 2, width: size, height: size }}
      />
    );
  }
  return <div data-testid="baseline-ghost" className="absolute h-1 rounded-sm bg-[var(--baseline)]" style={{ left, width: right - left, top: rowHeight - 5 }} />;
}

function RowBar({
  entry,
  span,
  timeline,
  style,
  resources,
}: {
  entry: BoardRow;
  span: Span;
  timeline: Timeline;
  style: BarStyle;
  resources: ReadonlyMap<string, ResourceDto>;
}) {
  const { row, kind } = entry;
  const rowHeight = ROW_HEIGHT[style];
  const { left, right } = extent(kind, span, timeline, style);
  const width = right - left;
  const task = row.kind === "task" ? row : null;
  const assignee = task?.resourceId ? resources.get(task.resourceId) : undefined;
  const details = barDetails(span, assignee?.name);
  const label = `${row.title || "Untitled"}, ${details}`;
  const locked = task?.locked ? <Lock aria-label="Locked" size={10} className="shrink-0" /> : null;
  const outsideTitle = (
    <span className="absolute flex items-center gap-1 whitespace-nowrap text-xs" style={{ left: right + 6, top: 0, height: rowHeight }}>
      {kind === "task" ? locked : null}
      <span className={kind === "parent" ? "font-semibold" : kind === "section" ? "text-muted" : ""}>{row.title}</span>
    </span>
  );

  if (kind === "section") {
    return (
      <>
        <div role="img" aria-label={label} className="absolute h-[3px] rounded bg-[var(--section)]" style={{ left, width, top: rowHeight / 2 - 1 }} />
        {outsideTitle}
      </>
    );
  }
  if (kind === "parent") {
    return (
      <>
        <div role="img" aria-label={label} className="absolute" style={{ left, width, top: rowHeight / 2 - 3, height: 10 }}>
          <div className="h-1.5 rounded-sm bg-[var(--parent)]" />
          <div className="absolute top-0 left-0 h-2.5 w-1 bg-[var(--parent)] [clip-path:polygon(0_0,100%_0,0_100%)]" />
          <div className="absolute top-0 right-0 h-2.5 w-1 bg-[var(--parent)] [clip-path:polygon(0_0,100%_0,100%_100%)]" />
        </div>
        {outsideTitle}
      </>
    );
  }
  const { fill, ink } = taskColors(task!.color);
  if (kind === "milestone") {
    const size = DIAMOND[style];
    return (
      <>
        <div role="img" aria-label={label} className="absolute rotate-45 rounded-[2px]" style={{ left, top: rowHeight / 2 - size / 2, width: size, height: size, background: fill }} />
        {outsideTitle}
      </>
    );
  }
  const barHeight = BAR_HEIGHT[style];
  if (style === "compact") {
    return (
      <>
        <div
          role="img"
          aria-label={label}
          className={`absolute rounded-[3px] ${entry.violation ? "outline-2 outline-offset-1 outline-[var(--violation)]" : ""}`}
          style={{ left, width, top: (rowHeight - barHeight) / 2, height: barHeight, background: fill }}
        />
        {outsideTitle}
      </>
    );
  }
  // Roomy: avatar then title inside, cut off with "…"; hovering shows the whole title beside the bar.
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <div
          role="img"
          aria-label={label}
          className={`absolute flex items-center gap-1.5 overflow-hidden rounded-[4px] px-1.5 text-xs font-semibold ${entry.violation ? "outline-2 outline-offset-1 outline-[var(--violation)]" : ""}`}
          style={{ left, width, top: (rowHeight - barHeight) / 2, height: barHeight, background: fill, color: ink }}
        >
          {assignee && width >= 44 ? <Avatar name={assignee.name} color={assignee.avatarColor} size={18} /> : null}
          {locked}
          <span className="truncate">{row.title}</span>
        </div>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side="right" sideOffset={8} className="z-50 max-w-80 rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text shadow-lg">
          <p className="font-semibold">{row.title || "Untitled"}</p>
          <p className="text-muted">{details}</p>
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
