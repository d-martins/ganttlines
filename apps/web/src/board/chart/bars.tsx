import type { ResourceDto } from "@ganttlines/protocol";
import type { HTMLAttributes } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Lock } from "lucide-react";
import { spanEnd, spanStart, type Span } from "@ganttlines/engine";
import { Avatar } from "../../ui/avatar";
import { formatDay, taskColors } from "../format";
import type { BoardRow, DrawKind, Ghost } from "../model";
import type { BarStyle } from "../view-store";
import type { Timeline } from "./timeline";

export const ROW_HEIGHT: Record<BarStyle, number> = { compact: 30, roomy: 40 };
export const BAR_HEIGHT: Record<BarStyle, number> = { compact: 14, roomy: 28 };
const DIAMOND: Record<BarStyle, number> = { compact: 12, roomy: 16 };

/** Horizontal extent of a drawn row: bars span their days; a milestone is a diamond on its day. */
export function extent(kind: DrawKind | Ghost["kind"], span: Span, timeline: Timeline, style: BarStyle): { left: number; right: number } {
  if (kind === "milestone") {
    const center = timeline.x(span.start) + timeline.dayWidth / 2;
    return { left: center - DIAMOND[style] / 2, right: center + DIAMOND[style] / 2 };
  }
  // Half days: an afternoon start begins mid-column, a midday end stops mid-column.
  const left = timeline.xHalf(spanStart(span));
  return { left, right: Math.max(timeline.xHalfEnd(spanEnd(span)), left + 2) };
}

/** "2.5" — working days in half-day steps. */
export const formatDays = (days: number) => (Number.isInteger(days) ? String(days) : days.toFixed(1));

const TRACK_COLOR = { over: "var(--awd-over)", under: "var(--awd-under)", even: "var(--awd-even)" } as const;

/**
 * The working days a task really took, as a thin track just under its bar (from the same start):
 * red when longer than planned, green when shorter, grey when on plan. Informational only.
 */
export function ActualTrack({ entry, timeline, style }: { entry: BoardRow; timeline: Timeline; style: BarStyle }) {
  if (!entry.actual) return null;
  const { left, right } = extent("task", entry.actual.span, timeline, style);
  const top = ROW_HEIGHT[style] / 2 + BAR_HEIGHT[style] / 2 + 1;
  return (
    <div
      data-testid="actual-track"
      data-versus-plan={entry.actual.versusPlan}
      aria-hidden
      className="pointer-events-none absolute h-[3px] rounded-full"
      style={{ left, width: right - left, top, background: TRACK_COLOR[entry.actual.versusPlan] }}
    />
  );
}

/**
 * The actual work days drawn on the bar itself: days beyond the plan continue the bar as a striped
 * red extension; planned days that weren't needed are dimmed with a dashed outline. The two parts
 * meet square (no rounding at the join). Informational only, never interactive.
 */
function ActualOnBar({ from, to, top, height, versusPlan, radius }: { from: number; to: number; top: number; height: number; versusPlan: "over" | "under"; radius: number }) {
  const common = { left: from, width: to - from, top, height, borderRadius: `0 ${radius}px ${radius}px 0` };
  if (versusPlan === "over") {
    return (
      <div
        data-testid="actual-over"
        aria-hidden
        className="pointer-events-none absolute"
        style={{ ...common, background: "repeating-linear-gradient(-45deg, var(--awd-over) 0 4px, color-mix(in srgb, var(--awd-over) 55%, transparent) 4px 8px)" }}
      />
    );
  }
  return (
    <div
      data-testid="actual-under"
      aria-hidden
      className="pointer-events-none absolute border border-l-0 border-dashed border-[var(--awd-under)]"
      style={{ ...common, background: "color-mix(in srgb, var(--bg) 70%, transparent)" }}
    />
  );
}

/**
 * The shape a row is drawn as: a collapsed parent task (its subtasks hidden) is drawn like a task
 * bar, in its own color, instead of the grey bracket.
 */
export function shapeOf(entry: Pick<BoardRow, "kind" | "collapsed">): DrawKind {
  return entry.kind === "parent" && entry.collapsed ? "task" : entry.kind;
}

/** Half the drawn height of a row's shape: where dependency arrows leave it (top or bottom edge). */
export function halfHeight(kind: DrawKind | Ghost["kind"], style: BarStyle): number {
  if (kind === "milestone") return (DIAMOND[style] * Math.SQRT2) / 2; // a rotated square
  if (kind === "parent") return 5;
  if (kind === "section") return 2;
  return BAR_HEIGHT[style] / 2;
}

const TITLE_FONT = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif';
let measureContext: CanvasRenderingContext2D | null | undefined;
const measured = new Map<string, number>();

/** Rendered width of a bar title (estimated where canvas is unavailable, e.g. tests). */
export function titleWidth(text: string): number {
  let width = measured.get(text);
  if (width === undefined) {
    if (measureContext === undefined) {
      try {
        measureContext = document.createElement("canvas").getContext("2d");
      } catch {
        measureContext = null;
      }
      if (measureContext) measureContext.font = TITLE_FONT;
    }
    width = measureContext ? measureContext.measureText(text).width : text.length * 7;
    if (measured.size > 5000) measured.clear();
    measured.set(text, width);
  }
  return width;
}

/** "Oct 5 – Oct 9, Ana"; half days: "Oct 5 (afternoon) – Oct 9 (morning)". */
export function barDetails(span: Span, assignee: string | undefined): string {
  const start = `${formatDay(span.start)}${span.startsAfternoon ? " (afternoon)" : ""}`;
  const end = `${formatDay(span.end)}${span.endsMidday ? " (morning)" : ""}`;
  const dates = span.start !== span.end ? `${start} – ${end}` : span.startsAfternoon ? start : span.endsMidday ? end : formatDay(span.start);
  return assignee ? `${dates}, ${assignee}` : dates;
}

/** A baseline's dates under the live bar (overlay mode). */
export function GhostBar({ ghost, timeline, style }: { ghost: Ghost; timeline: Timeline; style: BarStyle }) {
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
  // At the very bottom of the row, clear of the actual-days track just under the bar.
  return <div data-testid="baseline-ghost" className="absolute h-[2px] rounded-sm bg-[var(--baseline)]" style={{ left, width: right - left, top: rowHeight - 2 }} />;
}

/** Props for the drawn shape when it can be edited (focus, pointer and key handlers). */
export type ShapeProps = HTMLAttributes<HTMLDivElement>;

/** One row's bar, bracket, diamond or section span, with its title beside or inside it. */
export function RowBar({
  entry,
  span,
  timeline,
  style,
  resources,
  shape,
  titleGap = 6,
}: {
  entry: BoardRow;
  span: Span;
  timeline: Timeline;
  style: BarStyle;
  resources: ReadonlyMap<string, ResourceDto>;
  /** makes the shape interactive; read-only shapes are images */
  shape?: ShapeProps | undefined;
  /** space between the shape and a title drawn beside it (room for the link bullet) */
  titleGap?: number;
}) {
  const { row } = entry;
  const kind = shapeOf(entry);
  const rowHeight = ROW_HEIGHT[style];
  const { left, right: planRight } = extent(kind, span, timeline, style);
  const width = planRight - left;
  const actual = kind === "task" && entry.actual && entry.actual.versusPlan !== "even" ? entry.actual : null;
  const actualRight = actual ? extent("task", actual.span, timeline, style).right : planRight;
  // Titles beside the bar go after the overrun, if any.
  const right = Math.max(planRight, actualRight);
  const task = row.kind === "task" ? row : null;
  const assignee = task?.resourceId ? resources.get(task.resourceId) : undefined;
  const details =
    barDetails(span, assignee?.name) + (entry.actual && task ? `, took ${formatDays(entry.actualDays!)} of ${formatDays(task.duration)} working days` : "");
  const label = `${row.title || "Untitled"}, ${details}`;
  const locked = task?.locked ? <Lock aria-label="Locked" size={10} className="shrink-0" /> : null;
  const { className: shapeClass = "", ...shapeRest } = shape ?? {};
  const shapeAttrs: ShapeProps = shape ? { role: "button", "aria-label": label, ...shapeRest } : { role: "img", "aria-label": label };
  const outsideTitle = (
    <span className="pointer-events-none absolute flex items-center gap-1 whitespace-nowrap text-xs" style={{ left: right + titleGap, top: 0, height: rowHeight }}>
      {kind === "task" ? locked : null}
      <span className={kind === "parent" ? "font-semibold" : kind === "section" ? "text-muted" : ""}>{row.title}</span>
    </span>
  );

  if (kind === "section") {
    return (
      <>
        <div {...shapeAttrs} className={`absolute h-[3px] rounded bg-[var(--section)] ${shapeClass}`} style={{ left, width, top: rowHeight / 2 - 1 }} />
        {outsideTitle}
      </>
    );
  }
  if (kind === "parent") {
    return (
      <>
        <div {...shapeAttrs} className={`absolute ${shapeClass}`} style={{ left, width, top: rowHeight / 2 - 3, height: 10 }}>
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
        <div {...shapeAttrs} className={`absolute rotate-45 rounded-[2px] ${shapeClass}`} style={{ left, top: rowHeight / 2 - size / 2, width: size, height: size, background: fill }} />
        {outsideTitle}
      </>
    );
  }
  const barHeight = BAR_HEIGHT[style];
  const barTop = (rowHeight - barHeight) / 2;
  const radius = style === "compact" ? 3 : 4;
  // Overrun: the bar's right end is square where the extension joins it.
  const squareEnd = actual?.versusPlan === "over" ? "rounded-r-none!" : "";
  const onBar = actual ? (
    <ActualOnBar
      from={Math.min(planRight, actualRight)}
      to={Math.max(planRight, actualRight)}
      top={barTop}
      height={barHeight}
      versusPlan={actual.versusPlan as "over" | "under"}
      radius={radius}
    />
  ) : null;
  if (style === "compact") {
    return (
      <>
        <div
          {...shapeAttrs}
          className={`absolute rounded-[3px] ${squareEnd} ${entry.violation ? "outline-2 outline-offset-1 outline-[var(--violation)]" : ""} ${shapeClass}`}
          style={{ left, width, top: barTop, height: barHeight, background: fill }}
        />
        {onBar}
        {outsideTitle}
      </>
    );
  }
  // Roomy: avatar then the title inside when it fits; otherwise the title goes to the right of the bar.
  const showAvatar = Boolean(assignee) && width >= 44;
  const inside = 12 + (showAvatar ? 24 : 0) + (locked ? 16 : 0) + titleWidth(row.title) <= width;
  return (
    <>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <div
            {...shapeAttrs}
            className={`absolute flex items-center gap-1.5 overflow-hidden rounded-[4px] px-1.5 text-xs font-semibold ${squareEnd} ${entry.violation ? "outline-2 outline-offset-1 outline-[var(--violation)]" : ""} ${shapeClass}`}
            style={{ left, width, top: barTop, height: barHeight, background: fill, color: ink }}
          >
            {showAvatar ? <Avatar name={assignee!.name} color={assignee!.avatarColor} size={18} /> : null}
            {inside ? (
              <>
                {locked}
                <span className="truncate">{row.title}</span>
              </>
            ) : null}
          </div>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content side="right" sideOffset={8} className="z-50 max-w-80 rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text shadow-lg">
            <p className="font-semibold">{row.title || "Untitled"}</p>
            <p className="text-muted">{details}</p>
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
      {onBar}
      {inside ? null : outsideTitle}
    </>
  );
}
