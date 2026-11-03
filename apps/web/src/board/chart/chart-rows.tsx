import { fromDay, LINK_KIND_WORDS, spanEnd, spanStart, type Command, type DayNum, type LinkKind, type RowId } from "@ganttlines/engine";
import { UserRound } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { AssigneePicker } from "../assignee-picker";
import { runCommand, useBoard } from "../board-context";
import { addAtEnd, deleteRow } from "../list/list-actions";
import type { BoardRow } from "../model";
import { useSelection } from "../selection";
import type { BarStyle } from "../view-store";
import { BarMenu } from "./bar-menu";
import { ActualTrack, BAR_HEIGHT, barDetails, DOT_GAP, DOT_REACH, DOT_SIZE, extent, GhostBar, ROW_HEIGHT, RowBar } from "./bars";
import { dragCommand, edgeAt, linkKindOf, startAt, stepHalf, useChartDrag, type ChartDrag, type DragKind, type LinkEnd } from "./drag";
import type { Timeline } from "./timeline";
import { AUTO_SCROLL_STEP, AUTO_SCROLL_TICK_MS, edgePush, HEADER_HEIGHT } from "../auto-scroll";

const BAR_HELP_ID = "gp-bar-help";
/** pixels the pointer must travel before a press on a bar becomes a drag (a smaller movement is a click) */
const DRAG_THRESHOLD = 3;
/** a bar's quick tools: two 20 px buttons, 4 px apart */
const TOOLS_WIDTH = 44;

/**
 * Where a bar's quick tools start: left of its start dot, 4 px clear; past its end dot when the
 * chart's left edge leaves no room there.
 */
export const toolsLeft = (box: { left: number; right: number }) =>
  box.left - DOT_REACH - DOT_GAP >= TOOLS_WIDTH ? Math.max(box.left - 64, 0) : box.right + DOT_GAP + DOT_SIZE + DOT_GAP;

/** A link dot at chart x `left`: press and drag it onto another task to link them. */
function LinkDot({ left, top, title, onPointerDown }: { left: number; top: number; title: string; onPointerDown: (event: ReactPointerEvent) => void }) {
  return (
    <div
      aria-hidden
      title={title}
      onPointerDown={onPointerDown}
      className="absolute cursor-crosshair rounded-full border-2 border-[var(--dependency)] bg-bg opacity-0 group-hover/row:opacity-100 hover:scale-125"
      style={{ left, top: top - DOT_SIZE / 2, width: DOT_SIZE, height: DOT_SIZE }}
    />
  );
}

/**
 * The chart's rows as interactive strips: bars move, resize and link by dragging (previewed live
 * through the engine; the command is sent on drop), focused bars respond to the keyboard, hover
 * shows each bar's controls, and empty tracks show a ghost where a click would schedule the task.
 */
export function ChartRows({
  rows,
  allRows,
  firstRow,
  timeline,
  style,
  visibleLeft,
}: {
  /** the rendered window (already showing any drag preview) */
  rows: readonly BoardRow[];
  /** every shown row, for link targets and the blank row's position */
  allRows: readonly BoardRow[];
  firstRow: number;
  timeline: Timeline;
  style: BarStyle;
  /** chart x of the first visible pixel (the list covers what's left of it) */
  visibleLeft: number;
}) {
  const board = useBoard();
  const { state, resources, resourceMap, canEdit, canCreateResources } = board;
  const select = useSelection((selection) => selection.select);
  const drag = useChartDrag((store) => store.drag);
  const [hover, setHover] = useState<{ index: number; day: DayNum } | null>(null);
  const [menuFor, setMenuFor] = useState<RowId | null>(null);
  const rowHeight = ROW_HEIGHT[style];
  const barHeight = BAR_HEIGHT[style];
  // Handlers run long after render (window listeners): read the latest values through refs.
  const latest = useRef({ timeline, allRows, board });
  latest.current = { timeline, allRows, board };

  const run = (command: Command) => runCommand(latest.current.board, command);

  /** `linkFrom`: for link drags, the end of the bar the link leaves from. */
  const startDrag = (event: ReactPointerEvent, entry: BoardRow, absoluteIndex: number, kind: DragKind, linkFrom: LinkEnd = "end") => {
    if (!canEdit || event.button !== 0 || !entry.span) return;
    event.preventDefault();
    event.stopPropagation();
    const pressed = event.currentTarget as HTMLElement;
    const body = pressed.closest("[data-chart-body]") as HTMLElement;
    const span = entry.span;
    const rowId = entry.row.id;
    const startX = event.clientX;
    const startY = event.clientY;
    // Where the bar was grabbed, relative to its start: stays right even if the chart's range shifts mid-drag.
    const grabOffset = startX - body.getBoundingClientRect().left - timeline.x(span.start);
    const scroller = body.closest('[data-testid="board-scroller"]') as HTMLElement | null;
    const list = scroller?.querySelector('[role="treegrid"]') as HTMLElement | null;
    let moved = false;
    let current: ChartDrag | null = null;
    let last: PointerEvent | null = null;

    // Near or past the chart's visible edge, keep scrolling that way (and sideways drags keep up).
    const autoScroll = setInterval(() => {
      if (!moved || !last || !scroller) return;
      const bounds = scroller.getBoundingClientRect();
      const dx = edgePush(last.clientX, list ? list.getBoundingClientRect().right : bounds.left, bounds.right) * AUTO_SCROLL_STEP;
      const dy = kind === "link" ? edgePush(last.clientY, bounds.top + HEADER_HEIGHT, bounds.bottom) * AUTO_SCROLL_STEP : 0;
      if (!dx && !dy) return;
      const before = [scroller.scrollLeft, scroller.scrollTop];
      scroller.scrollLeft += dx;
      scroller.scrollTop += dy;
      if (scroller.scrollLeft !== before[0] || scroller.scrollTop !== before[1]) move(last);
    }, AUTO_SCROLL_TICK_MS);

    const move = (moveEvent: PointerEvent) => {
      last = moveEvent;
      if (!moved && Math.abs(moveEvent.clientX - startX) < DRAG_THRESHOLD && Math.abs(moveEvent.clientY - startY) < DRAG_THRESHOLD) return;
      moved = true;
      const rect = body.getBoundingClientRect();
      const x = moveEvent.clientX - rect.left;
      const y = moveEvent.clientY - rect.top;
      const { timeline: now, allRows: shown } = latest.current;
      if (kind === "link") {
        const target = shown[Math.floor(y / rowHeight)];
        // The follower's start when the pointer is over the left half of its bar, otherwise its end.
        let tie: { id: RowId; end: LinkEnd; kind: LinkKind } | null = null;
        if (target && target.row.kind === "task" && target.span && target.row.id !== rowId) {
          const box = extent(target.kind, target.span, now, style);
          const end: LinkEnd = x < (box.left + box.right) / 2 ? "start" : "end";
          tie = { id: target.row.id, end, kind: linkKindOf(linkFrom, end) };
        }
        const from = extent(entry.kind, span, now, style);
        current = {
          rowId,
          command: tie ? { type: "addLink", predecessorId: rowId, followerId: tie.id, kind: tie.kind } : null,
          line: { x1: linkFrom === "end" ? from.right + 8 : from.left - 8, y1: absoluteIndex * rowHeight + rowHeight / 2, x2: x, y2: y },
          targetId: tie?.id ?? null,
          from: linkFrom,
          targetEnd: tie?.end ?? null,
        };
      } else {
        current = { rowId, command: dragCommand(kind, rowId, span, now, x - grabOffset - now.x(span.start), x), line: null, targetId: null };
      }
      useChartDrag.setState({ drag: current });
    };
    const finish = (commit: boolean) => {
      clearInterval(autoScroll);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key, true);
      useChartDrag.setState({ drag: null });
      if (!moved) {
        // A click, not a drag: select the row, and focus the bar so the keyboard works on it next.
        select(rowId, false);
        if (kind === "move") pressed.focus({ preventScroll: true });
        return;
      }
      if (commit && current?.command) run(current.command);
    };
    const up = (upEvent: PointerEvent) => {
      move(upEvent); // the drop lands where the pointer is, even if no move event came since
      finish(true);
    };
    const key = (keyEvent: globalThis.KeyboardEvent) => {
      if (keyEvent.key !== "Escape") return;
      keyEvent.stopPropagation();
      finish(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key, true);
  };

  /** ←/→ move a focused bar a column (half a column at day zoom); Shift+←/→ change its end; Enter/Space open its options; Delete removes it. */
  const onBarKey = (event: KeyboardEvent, entry: BoardRow) => {
    const { row, span } = entry;
    if (!span || row.kind !== "task") return;
    const now = latest.current.timeline;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const step = event.key === "ArrowRight" ? 1 : -1;
      if (event.shiftKey) {
        const end = stepHalf(now, spanEnd(span), step);
        if (entry.kind === "task" && end >= spanStart(span) && end !== spanEnd(span)) run({ type: "resizeTask", id: row.id, edge: "end", ...edgeAt(end) });
      } else {
        const start = stepHalf(now, spanStart(span), step);
        if (start !== spanStart(span)) run({ type: "moveTask", id: row.id, ...startAt(start) });
      }
    } else if (event.key === "Enter" || event.key === " ") {
      setMenuFor(row.id);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      deleteRow(latest.current.board, row);
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      // The day menu (holidays, time off, highlights), for the task's first day: as a right-click there would.
      const target = event.currentTarget as HTMLElement;
      const body = target.closest("[data-chart-body]") as HTMLElement;
      const x = body.getBoundingClientRect().left + now.x(span.start) + 1;
      target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: target.getBoundingClientRect().bottom }));
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const trackDay = (event: ReactPointerEvent, index: number) => {
    if (!canEdit || drag) return;
    const body = (event.currentTarget as HTMLElement).closest("[data-chart-body]") as HTMLElement;
    const day = timeline.dayAt(event.clientX - body.getBoundingClientRect().left);
    if (hover?.index !== index || hover.day !== day) setHover({ index, day });
  };

  const blankIndex = allRows.length;
  return (
    <>
      <p id={BAR_HELP_ID} className="sr-only">
        Arrow keys move the task, Shift with arrow keys changes its length, Enter opens its options, Shift+F10 opens the menu for its first day.
      </p>
      {rows.map((entry, index) => {
        const absoluteIndex = firstRow + index;
        const { row, span, kind } = entry;
        const task = row.kind === "task" ? row : null;
        const unscheduledLeaf = task && !entry.isParent && !span;
        const editable = canEdit && task !== null && span !== null;
        const box = span ? extent(kind, span, timeline, style) : null;
        const center = rowHeight / 2;
        const dragging = drag?.rowId === row.id;
        const resizable = editable && kind === "task" && !task!.locked;
        const movable = editable && !(kind !== "parent" && task!.locked);
        return (
          <div
            key={row.id}
            data-row={absoluteIndex}
            className={`group/row absolute right-0 left-0 ${drag?.targetId === row.id ? "bg-accent-soft/60" : ""} ${entry.context ? "opacity-45" : ""}`}
            style={{ top: absoluteIndex * rowHeight, height: rowHeight }}
            onPointerMove={(event) => unscheduledLeaf && trackDay(event, absoluteIndex)}
            onPointerLeave={() => hover?.index === absoluteIndex && setHover(null)}
            onClick={() => {
              if (unscheduledLeaf && canEdit && hover?.index === absoluteIndex) run({ type: "moveTask", id: row.id, start: fromDay(hover.day) });
              select(row.id, false);
            }}
          >
            {entry.ghost ? <GhostBar ghost={entry.ghost} timeline={timeline} style={style} /> : null}
            <ActualTrack entry={entry} timeline={timeline} style={style} />
            {kind === "section" ? (
              <SectionBand title={row.title || "Untitled"} />
            ) : null}
            {span && kind !== "section" ? (
              <RowBar
                entry={entry}
                span={span}
                timeline={timeline}
                style={style}
                resources={resourceMap}
                titleGap={editable ? 18 : 6}
                visibleLeft={visibleLeft}
                shape={
                  editable
                    ? {
                        tabIndex: 0,
                        "aria-describedby": BAR_HELP_ID,
                        onPointerDown: (event) => (movable ? startDrag(event, entry, absoluteIndex, "move") : undefined),
                        onKeyDown: (event) => onBarKey(event, entry),
                        onFocus: (event) => event.currentTarget.matches(":focus-visible") && select(row.id, false),
                        className: `${movable ? "cursor-grab active:cursor-grabbing" : ""} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]`,
                      }
                    : undefined
                }
              />
            ) : null}
            {editable && box && !dragging ? (
              <>
                {resizable ? (
                  <>
                    <div
                      aria-hidden
                      title="Drag to change the start"
                      onPointerDown={(event) => startDrag(event, entry, absoluteIndex, "start")}
                      className="absolute cursor-ew-resize rounded-l opacity-0 group-hover/row:opacity-100 hover:bg-text/30"
                      style={{ left: box.left - 2, width: 7, top: center - barHeight / 2, height: barHeight }}
                    />
                    <div
                      aria-hidden
                      title="Drag to change the end"
                      onPointerDown={(event) => startDrag(event, entry, absoluteIndex, "end")}
                      className="absolute cursor-ew-resize rounded-r opacity-0 group-hover/row:opacity-100 hover:bg-text/30"
                      style={{ left: box.right - 5, width: 7, top: center - barHeight / 2, height: barHeight }}
                    />
                  </>
                ) : null}
                <LinkDot
                  left={box.left - DOT_REACH}
                  top={center}
                  title="Drag from the start onto another task to link them"
                  onPointerDown={(event) => startDrag(event, entry, absoluteIndex, "link", "start")}
                />
                <LinkDot left={box.right + DOT_GAP} top={center} title="Drag onto another task to link them" onPointerDown={(event) => startDrag(event, entry, absoluteIndex, "link")} />
                {/* Left of the bar, clear of its start dot; sticky, so it stays past the task list while the bar starts under it (and leaves with the bar). */}
                <div className="pointer-events-none absolute left-0 flex items-center" style={{ width: Math.max(box.right, toolsLeft(box) + TOOLS_WIDTH), top: center - 10, height: 20 }}>
                  <div
                    data-bar-tools
                    className={`pointer-events-auto sticky flex gap-1 group-focus-within/row:opacity-100 group-hover/row:opacity-100 ${menuFor === row.id ? "opacity-100" : "opacity-0"}`}
                    style={{ marginLeft: toolsLeft(box), left: "calc(var(--list-width) + 4px)" }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <AssigneePicker
                      value={task!.resourceId}
                      resources={resources}
                      canCreate={canCreateResources}
                      onChange={(resourceId) => run({ type: "setAssignee", id: row.id, resourceId })}
                      trigger={
                        <button
                          type="button"
                          aria-label={`Assign “${row.title || "Untitled"}”`}
                          className="flex h-5 w-5 items-center justify-center rounded bg-bg text-muted shadow-sm ring-1 ring-border hover:text-text"
                        >
                          <UserRound size={12} />
                        </button>
                      }
                    />
                    <BarMenu task={task!} isParent={entry.isParent} open={menuFor === row.id} onOpenChange={(open) => setMenuFor(open ? row.id : null)} />
                  </div>
                </div>
              </>
            ) : null}
            {dragging && span && box ? (
              <span className="pointer-events-none absolute z-10 rounded bg-text px-1.5 py-0.5 text-[11px] whitespace-nowrap text-bg shadow" style={{ left: box.left, top: center + barHeight / 2 + 3 }}>
                {barDetails(span, undefined)}
              </span>
            ) : null}
            {unscheduledLeaf && hover?.index === absoluteIndex ? (
              <div
                aria-hidden
                className="pointer-events-none absolute rounded-[3px] border-2 border-dashed border-accent bg-accent/15"
                style={{ left: timeline.x(hover.day), width: Math.max(task!.duration, 1) * timeline.dayWidth, top: center - barHeight / 2, height: barHeight }}
              />
            ) : null}
          </div>
        );
      })}
      {canEdit ? (
        // The blank row under the last task: click a day to add a task starting there.
        <div
          className="absolute right-0 left-0 cursor-copy"
          style={{ top: blankIndex * rowHeight, height: rowHeight }}
          onPointerMove={(event) => trackDay(event, blankIndex)}
          onPointerLeave={() => hover?.index === blankIndex && setHover(null)}
          onClick={() => hover?.index === blankIndex && addAtEnd(latest.current.board, state, "task", fromDay(hover.day))}
        >
          {hover?.index === blankIndex ? (
            <div
              aria-hidden
              className="pointer-events-none absolute rounded-[3px] border-2 border-dashed border-accent bg-accent/15"
              style={{ left: timeline.x(hover.day), width: timeline.dayWidth, top: rowHeight / 2 - barHeight / 2, height: barHeight }}
            />
          ) : null}
        </div>
      ) : null}
      {drag?.line ? <LinkDragPreview drag={drag} allRows={allRows} timeline={timeline} style={style} /> : null}
    </>
  );
}

/** A link being dragged: the line to the pointer, the end of the target it would tie to, and the kind in words. */
function LinkDragPreview({ drag, allRows, timeline, style }: { drag: ChartDrag; allRows: readonly BoardRow[]; timeline: Timeline; style: BarStyle }) {
  const line = drag.line!;
  const rowHeight = ROW_HEIGHT[style];
  const index = drag.targetId ? allRows.findIndex((entry) => entry.row.id === drag.targetId) : -1;
  const target = index >= 0 ? allRows[index]! : null;
  const end = target?.span && drag.targetEnd ? drag.targetEnd : null;
  const box = end ? extent(target!.kind, target!.span!, timeline, style) : null;
  const kind = end ? linkKindOf(drag.from ?? "end", end) : null;
  return (
    <>
      <svg aria-hidden className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
        <line x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} stroke="var(--accent)" strokeWidth={2} strokeDasharray="4 3" />
        <circle cx={line.x2} cy={line.y2} r={4} fill="var(--accent)" />
        {box ? (
          <circle
            data-testid="link-target-end"
            data-end={end}
            cx={end === "start" ? box.left : box.right}
            cy={index * rowHeight + rowHeight / 2}
            r={5}
            fill="var(--bg)"
            stroke="var(--accent)"
            strokeWidth={2}
          />
        ) : null}
      </svg>
      {kind ? (
        <span
          data-testid="link-kind"
          className="pointer-events-none absolute z-10 rounded bg-text px-1.5 py-0.5 text-[11px] whitespace-nowrap text-bg shadow"
          style={{ left: line.x2 + 12, top: line.y2 + 12 }}
        >
          {LINK_KIND_WORDS[kind]}
        </span>
      ) : null}
    </>
  );
}

/** A section on the chart: a band across the board, its name stuck (CSS) to the visible left edge. */
function SectionBand({ title }: { title: string }) {
  return (
    <div data-section-band className="pointer-events-none absolute inset-0 flex items-center border-y border-border bg-[var(--section-band)]">
      <span className="sticky text-xs font-semibold text-muted" style={{ left: "calc(var(--list-width) + 8px)" }}>
        {title}
      </span>
    </div>
  );
}
