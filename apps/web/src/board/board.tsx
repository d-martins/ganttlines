import { applyCommand, toDay, weekday, type Calendar, type DayNum, type ProjectState } from "@ganttlines/engine";
import type { BaselineTaskDto, CalendarDto, HighlightDto, ResourceDto } from "@ganttlines/protocol";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ROW_HEIGHT } from "./chart/bars";
import { ChartRows } from "./chart/chart-rows";
import { DayMenu } from "./chart/day-menu";
import { useChartDrag } from "./chart/drag";
import { ChartHeader } from "./chart/chart-header";
import { Dependencies } from "./chart/dependencies";
import { Shading } from "./chart/shading";
import { chartRange, DAY_WIDTH, Timeline } from "./chart/timeline";
import { today } from "./format";
import { useBoard } from "./board-context";
import { useCollapsed } from "./collapse";
import { ListHeader, ListRows, useListKeys } from "./list/task-list";
import { DetailsPanel } from "./panel/details-panel";
import { useSelection } from "./selection";
import { boardModel, type CompareMode } from "./model";
import { useBoardView } from "./view-store";

const HEADER_HEIGHT = 48;
const OVERSCAN_ROWS = 10;
const OVERSCAN_PX = 600;
/** Where "today" (and the day kept in place when zooming) sits: a third into the chart. */
const ANCHOR = 1 / 3;

interface Viewport {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** The size of the scroll area; jsdom reports 0, so tests get a sensible default. */
const measure = (element: HTMLElement): Viewport => ({
  top: element.scrollTop,
  left: element.scrollLeft,
  width: element.clientWidth || 1200,
  height: element.clientHeight || 800,
});

/**
 * Task list | divider | chart. Both scroll vertically together (one scroll area; the list and
 * header are sticky), the chart also scrolls sideways, and only rows and days near the viewport
 * are rendered.
 */
export function Board({
  state,
  calendar,
  calendarDto,
  resources,
  highlights,
  baseline,
}: {
  state: ProjectState;
  calendar: Calendar;
  calendarDto: CalendarDto;
  resources: readonly ResourceDto[];
  highlights: readonly HighlightDto[];
  baseline: { mode: CompareMode; tasks: readonly BaselineTaskDto[] } | null;
}) {
  const { zoom, barStyle, showWeekends, listWidth, todayRequest, setListWidth } = useBoardView();
  const [query, setQuery] = useState("");
  const { canEdit, sync } = useBoard();
  const collapsed = useCollapsed(sync.projectId);
  // While a bar is dragged, show the board as the drop would leave it (successors pushed and all).
  const dragCommand = useChartDrag((store) => store.drag?.command ?? null);
  const displayed = useMemo(() => {
    if (!dragCommand) return state;
    const result = applyCommand(state, calendar, dragCommand);
    return result.ok ? result.state : state;
  }, [state, calendar, dragCommand]);
  const model = useMemo(() => boardModel(displayed, calendar, baseline, query, collapsed), [displayed, calendar, baseline, query, collapsed]);
  const { selectedId, select, centerRequest } = useSelection();
  const onListKey = useListKeys(model.rows);
  const todayDay = today();
  const highlightDays = useMemo(() => highlights.map((highlight) => ({ day: toDay(highlight.date), highlight })), [highlights]);

  const { first, last } = useMemo(() => {
    const days: DayNum[] = highlightDays.map(({ day }) => day);
    for (const { span, ghost } of model.rows) {
      if (span) days.push(span.start, span.end);
      if (ghost) days.push(ghost.span.start, ghost.span.end);
    }
    return chartRange(days, todayDay);
  }, [model, highlightDays, todayDay]);
  const timeline = useMemo(() => {
    const working = new Set(calendarDto.workingWeekdays);
    const hidden = showWeekends ? undefined : (day: DayNum) => !working.has(weekday(day));
    return new Timeline(first, last, DAY_WIDTH[zoom], hidden);
  }, [first, last, zoom, showWeekends, calendarDto.workingWeekdays]);

  const scroller = useRef<HTMLDivElement>(null);
  const chartBody = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ top: 0, left: 0, width: 1200, height: 800 });
  /**
   * The point kept in place when the timeline changes (zoom, weekends, the range growing during a
   * drag): a day plus how far into it, as a fraction of a column. Keeping the fraction matters:
   * rounding to the day's start on every change made the chart creep backwards while dragging.
   */
  const anchor = useRef<{ day: DayNum; fraction: number }>({ day: todayDay, fraction: 0.5 });
  const frame = useRef(0);

  const chartWidth = Math.max(viewport.width - listWidth, 0);
  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    const x = element.scrollLeft + chartWidth * ANCHOR;
    const day = timeline.dayAt(x);
    anchor.current = { day, fraction: Math.min(Math.max((x - timeline.x(day)) / timeline.dayWidth, 0), 1) };
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setViewport(measure(element)));
  };

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewport(measure(element)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Keep the anchor day in place when the timeline changes, and jump to today on request.
  const lastTodayRequest = useRef(todayRequest);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (lastTodayRequest.current !== todayRequest) {
      lastTodayRequest.current = todayRequest;
      anchor.current = { day: todayDay, fraction: 0.5 };
    }
    const { day, fraction } = anchor.current;
    element.scrollLeft = Math.max(timeline.x(day) + fraction * timeline.dayWidth - chartWidth * ANCHOR, 0);
    setViewport(measure(element));
    // chartWidth is left out on purpose: resizing the window should not jump the chart.
  }, [timeline, todayRequest, todayDay]);

  const rowHeight = ROW_HEIGHT[barStyle];
  const firstRow = Math.max(Math.floor(viewport.top / rowHeight) - OVERSCAN_ROWS, 0);
  const lastRow = Math.min(Math.ceil((viewport.top + viewport.height) / rowHeight) + OVERSCAN_ROWS, model.rows.length);
  const shown = model.rows.slice(firstRow, lastRow);
  const days = timeline.daysBetween(viewport.left - OVERSCAN_PX, viewport.left + chartWidth + OVERSCAN_PX);
  // One spare row under the last task holds "+ Add task / + Add section".
  const bodyHeight = Math.max((model.rows.length + (canEdit ? 1 : 0)) * rowHeight, viewport.height - HEADER_HEIGHT);
  const selectedIndex = model.rows.findIndex((entry) => entry.row.id === selectedId);

  // Center the chart on a row's bar when asked (a click on the already selected row).
  useEffect(() => {
    const element = scroller.current;
    const span = centerRequest ? model.rows.find((entry) => entry.row.id === centerRequest.id)?.span : null;
    if (!element || !span) return;
    const middle = (timeline.x(span.start) + timeline.xEnd(span.end)) / 2;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const left = Math.max(middle - chartWidth / 2, 0);
    if (typeof element.scrollTo === "function") element.scrollTo({ left, behavior: reduce ? "auto" : "smooth" });
    else element.scrollLeft = left;
    // Only a new request moves the chart; later edits to the row don't.
    // (model/timeline/chartWidth are read at request time.)
  }, [centerRequest]);

  // Keep the selected row on screen (keyboard moves, new rows).
  useEffect(() => {
    const element = scroller.current;
    if (!element || selectedIndex < 0) return;
    const top = selectedIndex * rowHeight;
    const visibleHeight = element.clientHeight - HEADER_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (visibleHeight > 0 && top + rowHeight > element.scrollTop + visibleHeight) element.scrollTop = top + rowHeight - visibleHeight;
  }, [selectedIndex, rowHeight]);
  const grid = { backgroundImage: `linear-gradient(to bottom, transparent ${rowHeight - 1}px, var(--grid) ${rowHeight - 1}px)`, backgroundSize: `100% ${rowHeight}px` };

  const startResize = (event: ReactPointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = listWidth;
    const move = (moveEvent: PointerEvent) => setListWidth(startWidth + moveEvent.clientX - startX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const divider = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize task list"
      onPointerDown={startResize}
      className="absolute top-0 right-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-accent/40"
    />
  );

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {model.cycle ? (
        <p role="alert" className="border-b border-border bg-surface px-4 py-2 text-sm text-danger">
          These tasks' dependencies form a loop, so their dates can't be worked out.
        </p>
      ) : null}
      <div ref={scroller} onScroll={onScroll} data-testid="board-scroller" className="relative min-h-0 flex-1 overflow-auto">
        <div style={{ width: listWidth + timeline.width }}>
          <div className="sticky top-0 z-20 flex" style={{ height: HEADER_HEIGHT }}>
            <div className="sticky left-0 z-10 shrink-0 overflow-hidden border-r border-border bg-surface" style={{ width: listWidth }}>
              <ListHeader query={query} onQuery={setQuery} />
              {divider}
            </div>
            <ChartHeader timeline={timeline} zoom={zoom} stickyLeft={listWidth} days={days} highlights={highlightDays} todayDay={todayDay} />
          </div>
          <div className="flex" style={{ height: bodyHeight }}>
            <div
              role="treegrid"
              aria-label="Tasks"
              aria-rowcount={model.rows.length}
              aria-multiselectable={false}
              // Not a Tab stop itself (its cells are); focused on row clicks so the list keys keep working.
              tabIndex={-1}
              onKeyDown={onListKey}
              onMouseDown={(event) => {
                const target = event.target as HTMLElement;
                if (target.closest("button, input")) return;
                if (!target.closest('[role="row"]')) {
                  // Empty space below the rows: nothing selected, and the list lets go of focus.
                  event.preventDefault();
                  select(null);
                  if (event.currentTarget.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
                  return;
                }
                event.currentTarget.focus({ preventScroll: true });
              }}
              className="sticky left-0 z-10 shrink-0 overflow-hidden border-r border-border bg-bg outline-none focus:outline-none focus-visible:outline-none"
              style={{ width: listWidth, height: bodyHeight, ...grid }}
            >
              <ListRows rows={shown} allRows={model.rows} firstRow={firstRow} rowHeight={rowHeight} numbers={model.numbers} searching={query.trim() !== ""} />
              {divider}
            </div>
            <DayMenu
              projectId={sync.projectId}
              enabled={canEdit}
              dayAt={(clientX) => timeline.dayAt(clientX - (chartBody.current?.getBoundingClientRect().left ?? 0))}
              highlights={highlightDays}
              resources={resources}
            >
            <div ref={chartBody} data-chart-body className="relative shrink-0 overflow-hidden" style={{ width: timeline.width, height: bodyHeight, ...grid }}>
              <Shading
                timeline={timeline}
                calendar={calendar}
                calendarDto={calendarDto}
                days={days}
                rows={shown}
                rowHeight={rowHeight}
                firstRow={firstRow}
                height={bodyHeight}
                highlights={highlightDays}
              />
              {selectedIndex >= 0 ? (
                <div aria-hidden className="absolute right-0 left-0 bg-accent-soft opacity-60" style={{ top: selectedIndex * rowHeight, height: rowHeight }} />
              ) : null}
              <div aria-hidden className="absolute top-0 w-0.5 bg-[var(--today)]" style={{ left: timeline.x(todayDay) + timeline.dayWidth / 2 - 1, height: bodyHeight }} />
              <Dependencies rows={model.rows} firstRow={firstRow} lastRow={lastRow} timeline={timeline} style={barStyle} />
              <ChartRows rows={shown} allRows={model.rows} firstRow={firstRow} timeline={timeline} style={barStyle} visibleLeft={viewport.left} />
            </div>
            </DayMenu>
          </div>
        </div>
        {model.rows.length === 0 ? <p className="absolute top-16 left-4 text-sm text-muted">No tasks yet.</p> : null}
      </div>
      <DetailsPanel numbers={model.numbers} />
    </div>
  );
}
