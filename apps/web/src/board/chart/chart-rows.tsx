import type { SlackAnalysis } from "@ganttlines/engine";
import { fromDay, spanEnd, spanStart, type Command, type DayNum, type RowId } from "@ganttlines/engine";
import { ArrowLeft, ArrowRight, SquareCenterlineDashedHorizontal, UserRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { AssigneePicker } from "../assignee-picker";
import { runCommand, useBoard } from "../board-context";
import { useCriticalPath } from "../critical-path-view";
import { useSlackAnalysis } from "../slack";
import { LinkChoiceMenu, type LinkChoice } from "./link-choice";
import { addAtEnd, deleteRow } from "../list/list-actions";
import type { BoardRow } from "../model";
import { useSelection } from "../selection";
import type { BarStyle } from "../view-store";
import { BarMenu } from "./bar-menu";
import { Cutting, startCutting } from "./cutting";
import { ActualTrack, BAR_HEIGHT, barDetails, DOT_GAP, DOT_REACH, DOT_SIZE, extent, GhostBar, ROW_HEIGHT, RowBar } from "./bars";
import { dragCommand, edgeAt, gapCommand, useHoveredRow, startAt, stepHalf, useChartDrag, type ChartDrag, type DragKind } from "./drag";
import { TagChips, type TagFilter } from "./tag-chips";
import type { Timeline } from "./timeline";
import { AUTO_SCROLL_STEP, AUTO_SCROLL_TICK_MS, edgePush, HEADER_HEIGHT } from "../auto-scroll";

const BAR_HELP_ID = "gp-bar-help";
/** pixels the pointer must travel before a press on a bar becomes a drag (a smaller movement is a click) */
const DRAG_THRESHOLD = 3;
/** a bar's quick tools: three 20 px buttons, 4 px apart */
const TOOLS_WIDTH = 68;

/**
 * Where a bar's quick tools start: left of its start dot, 4 px clear; past its end dot when the
 * chart's left edge leaves no room there.
 */
export const toolsLeft = (box: { left: number; right: number }) =>
  box.left - DOT_REACH - DOT_GAP >= TOOLS_WIDTH ? Math.max(box.left - TOOLS_WIDTH - 20, 0) : box.right + DOT_GAP + DOT_SIZE + DOT_GAP;

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
/** What a bar's outline says; none for dates drawn from a baseline. */
function slackMark(entry: BoardRow, { slack, pastTarget }: SlackAnalysis, critical: boolean): "late" | "zero" | null {
  if (entry.fromBaseline) return null;
  const mine = slack.get(entry.row.id);
  if (!mine) return null;
  // A missed milestone always shows; the rest only when asked for.
  if (pastTarget.has(entry.row.id) || (mine.halves < 0 && (critical || mine.limit.kind === "milestone"))) return "late";
  return critical && mine.halves === 0 ? "zero" : null;
}

/** Where the edge arrows stick: 4 px past the task list (the quick tools stick past the arrow), clear of the drawer's strip. */
const EDGE_ARROW = 20;
/** The quick tools stick this far past the task list: the left arrow and a gap either side. */
const TOOLS_STICK = 4 + EDGE_ARROW + 4;
/** Where the right arrows stick: clear of the details drawer's collapsed strip (36 px), and a gap. */
export const EDGE_RIGHT = 40;
const ARROW_BUTTON =
  "pointer-events-auto sticky hidden h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded bg-bg text-muted/55 shadow-sm ring-1 ring-border group-hover/row:text-muted hover:text-text! motion-reduce:animate-none!";
/** How much room an edge arrow's click leaves between the bar and that edge, in days. */
const EDGE_ROOM_DAYS = 4.5;

/**
 * Where an edge arrow's click scrolls the chart: back until the bar's start is EDGE_ROOM_DAYS in from the task list
 * (or further, past where its left arrow shows), or on until its end has EDGE_ROOM_DAYS of room before the right edge.
 */
export function edgeScrollTarget(side: "left" | "right", box: { left: number; right: number }, dayWidth: number, chartWidth: number): number {
  const room = EDGE_ROOM_DAYS * dayWidth;
  const left = side === "left" ? Math.min(box.left - room, toolsLeft(box) - TOOLS_STICK - 1) : box.right + room + EDGE_RIGHT - chartWidth;
  return Math.max(left, 0);
}

/**
 * Tells each row whether its bar is past the chart's left or right edge (data-past-left / data-past-right), which shows
 * its edge arrows. The browser reports it, as each bar's markers go out of view: no work while scrolling, and no React.
 * The visible chart is the scroll area less the task list (left) and the drawer's strip (right); rows above and below
 * count as in view.
 */
function useEdgeMarkers(scroller: RefObject<HTMLElement | null> | undefined, listWidth: number) {
  const markers = useRef(new Set<HTMLElement>());
  const observer = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    const root = scroller?.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const watch = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const side = (entry.target as HTMLElement).dataset["edgeMarker"];
          entry.target.closest("[data-row]")?.toggleAttribute(`data-past-${side}`, !entry.isIntersecting);
        }
      },
      { root, rootMargin: `10000px -${EDGE_RIGHT}px 10000px -${listWidth}px` },
    );
    observer.current = watch;
    for (const marker of markers.current) watch.observe(marker);
    return () => {
      watch.disconnect();
      observer.current = null;
    };
  }, [scroller, listWidth]);
  return useCallback((marker: HTMLElement | null) => {
    if (!marker) return;
    markers.current.add(marker);
    observer.current?.observe(marker);
    return () => {
      markers.current.delete(marker);
      observer.current?.unobserve(marker);
    };
  }, []);
}

/**
 * Arrows at the chart's edges for a bar that's past them: left once its start has gone under the task list (as its
 * quick tools start to stick), right once its end has gone past the right edge. Sticky, they sit at the edges, above
 * the bar, its title and its quick tools; the row's data-past-* attributes (useEdgeMarkers) show them. Each bar has
 * two invisible markers: from the chart's start to where its quick tools start sticking, and from its end to the
 * chart's end; one wholly out of view means the bar is past that edge. For the mouse: the list's "Show on chart" is
 * the keyboard's way.
 */
function EdgeArrows({
  box,
  top,
  title,
  id,
  marker,
  onClick,
}: {
  box: { left: number; right: number };
  top: number;
  title: string;
  id: string;
  marker: (element: HTMLElement | null) => void;
  onClick: (side: "left" | "right") => void;
}) {
  const label = `Scroll to “${title}”`;
  const arrow = (side: "left" | "right") => (
    <button
      type="button"
      tabIndex={-1}
      title={label}
      data-edge-arrow={side}
      data-row-id={id}
      className={`${ARROW_BUTTON} ${side === "left" ? "group-data-[past-left]/row:flex group-data-[past-left]/row:animate-edge-in-left" : "ml-auto group-data-[past-right]/row:flex group-data-[past-right]/row:animate-edge-in-right"}`}
      style={side === "right" ? { right: "var(--edge-right, 4px)" } : { left: "calc(var(--list-width) + 4px)" }}
      onClick={(event) => {
        event.stopPropagation();
        onClick(side);
      }}
    >
      {side === "right" ? <ArrowRight size={12} /> : <ArrowLeft size={12} />}
    </button>
  );
  return (
    <div aria-hidden>
      <div ref={marker} data-edge-marker="left" className="pointer-events-none absolute" style={{ left: 0, width: Math.max(toolsLeft(box) - TOOLS_STICK, 1), top, height: 1 }} />
      <div ref={marker} data-edge-marker="right" className="pointer-events-none absolute right-0" style={{ left: box.right, top, height: 1 }} />
      <div className="pointer-events-none absolute right-0 left-0 z-[5] flex" style={{ top, height: EDGE_ARROW }}>
        {arrow("left")}
        {arrow("right")}
      </div>
    </div>
  );
}

export function ChartRows({
  rows,
  allRows,
  firstRow,
  timeline,
  style,
  tagFilter,
  filtering,
  scroller,
  listWidth = 0,
}: {
  /** the board's scroll area and the task list's width: where the edge arrows' markers are watched from */
  scroller?: RefObject<HTMLElement | null>;
  listWidth?: number;
  /** the rendered window (already showing any drag preview) */
  rows: readonly BoardRow[];
  /** every shown row, for link targets and the blank row's position */
  allRows: readonly BoardRow[];
  firstRow: number;
  timeline: Timeline;
  style: BarStyle;
  /** what a click on a task's tag does: toggles it in the board's filter */
  tagFilter: TagFilter;
  /** the board is filtered: no rows are added from the chart */
  filtering: boolean;
}) {
  const board = useBoard();
  const { state, resources, resourceMap, canEdit, canCreateResources } = board;
  const slack = useSlackAnalysis();
  const [linkChoice, setLinkChoice] = useState<LinkChoice | null>(null);
  const critical = useCriticalPath(board.sync.projectId);
  const select = useSelection((selection) => selection.select);
  const edgeMarker = useEdgeMarkers(scroller, listWidth);
  const drag = useChartDrag((store) => store.drag);
  const [hover, setHover] = useState<{ index: number; day: DayNum } | null>(null);
  const menuFor = useChartDrag((store) => store.menuFor);
  const setMenuFor = (menuFor: RowId | null) => useChartDrag.setState({ menuFor });
  // Selected, so an edit in the menu that takes the row out of a filter doesn't take the row, and the menu, away at once.
  const openMenu = (id: RowId) => {
    select(id, false);
    setMenuFor(id);
  };
  // A row that goes away takes its menu along: it must not open by itself when the row comes back.
  const menuRowShown = rows.some((entry) => entry.row.id === menuFor && entry.span !== null);
  useEffect(() => {
    if (menuFor !== null && !menuRowShown) setMenuFor(null);
  }, [menuFor, menuRowShown]);
  useEffect(() => () => setMenuFor(null), []);
  const rowHeight = ROW_HEIGHT[style];
  const barHeight = BAR_HEIGHT[style];
  // Handlers run long after render (window listeners): read the latest values through refs.
  const latest = useRef({ timeline, allRows, board });
  latest.current = { timeline, allRows, board };

  const run = (command: Command) => runCommand(latest.current.board, command);

  /** `pause`: for dragging an edge of a gap, which pause. */
  const startDrag = (event: ReactPointerEvent, entry: BoardRow, absoluteIndex: number, kind: DragKind, pause?: BoardRow["pauses"][number]) => {
    if (!canEdit || event.button !== 0 || !entry.span) return;
    event.preventDefault();
    event.stopPropagation();
    // Stopping the press here keeps it from an open menu, which would have closed on it.
    setLinkChoice(null);
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
        const onTask = target && target.row.kind === "task" && target.span && target.row.id !== rowId;
        const from = extent(entry.kind, span, now, style);
        current = {
          rowId,
          command: null,
          line: { x1: from.right + 8, y1: absoluteIndex * rowHeight + rowHeight / 2, x2: x, y2: y },
          targetId: onTask ? target.row.id : null,
        };
      } else if (kind === "gapStart" || kind === "gapEnd") {
        current = { rowId, command: gapCommand(kind, rowId, pause!, now, x), line: null, targetId: null };
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
      if (commit && current?.targetId) setLinkChoice({ x: last?.clientX ?? startX, y: last?.clientY ?? startY, fromId: rowId, toId: current.targetId });
      else if (commit && current?.command) run(current.command);
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
      openMenu(row.id);
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
            onPointerEnter={() => useHoveredRow.setState({ id: row.id })}
            onPointerMove={(event) => unscheduledLeaf && trackDay(event, absoluteIndex)}
            onPointerLeave={() => {
              useHoveredRow.setState((current) => (current.id === row.id ? { id: null } : current));
              if (hover?.index === absoluteIndex) setHover(null);
            }}
            // A double-click on a bar opens its details.
            onDoubleClick={(event) => {
              if ((event.target as HTMLElement).closest("[data-bar]")) select(row.id, true);
            }}
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
            {box && kind !== "section" ? (
              <EdgeArrows
                box={box}
                top={center - 10}
                title={row.title || "Untitled"}
                id={row.id}
                marker={edgeMarker}
                onClick={(side) => {
                  select(row.id, false);
                  const element = scroller?.current;
                  if (!element) return;
                  const left = edgeScrollTarget(side, box, timeline.dayWidth, Math.max(element.clientWidth - listWidth, 0));
                  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
                  if (typeof element.scrollTo === "function") element.scrollTo({ left, behavior: reduce ? "auto" : "smooth" });
                  else element.scrollLeft = left;
                }}
              />
            ) : null}
            {span && kind !== "section" ? (
              <RowBar
                entry={entry}
                span={span}
                timeline={timeline}
                style={style}
                resources={resourceMap}
                titleGap={editable ? 18 : 6}
                slack={slackMark(entry, slack, critical)}
                tags={task && task.tags.length > 0 ? <TagChips title={row.title} tags={task.tags} filter={tagFilter} /> : null}
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
                {resizable
                  ? entry.pauses.flatMap((pause) => [
                      <div
                        key={`${pause.after}-start`}
                        aria-hidden
                        data-testid="gap-edge"
                        title="Drag to change the interruption"
                        onPointerDown={(event) => startDrag(event, entry, absoluteIndex, "gapStart", pause)}
                        className="absolute cursor-ew-resize rounded-r opacity-0 group-hover/row:opacity-100 hover:bg-text/30"
                        style={{ left: timeline.xHalfEnd(pause.lastWorked) - 5, width: 7, top: center - barHeight / 2, height: barHeight }}
                      />,
                      <div
                        key={`${pause.after}-end`}
                        aria-hidden
                        data-testid="gap-edge"
                        title="Drag to change the interruption"
                        onPointerDown={(event) => startDrag(event, entry, absoluteIndex, "gapEnd", pause)}
                        className="absolute cursor-ew-resize rounded-l opacity-0 group-hover/row:opacity-100 hover:bg-text/30"
                        style={{ left: timeline.xHalf(pause.resume) - 2, width: 7, top: center - barHeight / 2, height: barHeight }}
                      />,
                    ])
                  : null}
                <LinkDot left={box.right + DOT_GAP} top={center} title="Drag onto another task to link them" onPointerDown={(event) => startDrag(event, entry, absoluteIndex, "link")} />
                {/* Left of the bar, clear of its start dot; sticky, so it stays past the task list and the left edge arrow while the bar
                    starts under it (and leaves with the bar, sliding out behind the arrow). */}
                <div className="pointer-events-none absolute left-0 flex items-center" style={{ width: Math.max(box.right, toolsLeft(box) + TOOLS_WIDTH), top: center - 10, height: 20 }}>
                  <div
                    data-bar-tools
                    className={`pointer-events-auto sticky flex gap-1 group-focus-within/row:opacity-100 group-hover/row:opacity-100 ${menuFor === row.id ? "opacity-100" : "opacity-0"}`}
                    style={{ marginLeft: toolsLeft(box), left: `calc(var(--list-width) + ${TOOLS_STICK}px)` }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {resizable ? (
                      <button
                        type="button"
                        aria-label={`Interrupt “${row.title || "Untitled"}”`}
                        title="Interrupt this task"
                        disabled={task!.duration < 1}
                        onClick={() => startCutting(entry)}
                        className="flex h-5 w-5 items-center justify-center rounded bg-bg text-muted shadow-sm ring-1 ring-border hover:text-text disabled:opacity-40"
                      >
                        <SquareCenterlineDashedHorizontal size={12} />
                      </button>
                    ) : null}
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
                    <BarMenu task={task!} isParent={entry.isParent} open={menuFor === row.id} onOpenChange={(open) => (open ? openMenu(row.id) : setMenuFor(null))} />
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
      {canEdit && !filtering ? (
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
      <Cutting rows={allRows} timeline={timeline} style={style} run={run} />
      {drag?.line ? <LinkDragPreview line={drag.line} /> : null}
      {linkChoice ? <LinkChoiceMenu choice={linkChoice} state={board.state} calendar={board.calendar} run={run} onClose={() => setLinkChoice(null)} /> : null}
    </>
  );
}

/** A link being dragged: the line to the pointer. */
function LinkDragPreview({ line }: { line: NonNullable<ChartDrag["line"]> }) {
  return (
    <svg aria-hidden className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
      <line x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} stroke="var(--accent)" strokeWidth={2} strokeDasharray="4 3" />
      <circle cx={line.x2} cy={line.y2} r={4} fill="var(--accent)" />
    </svg>
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
