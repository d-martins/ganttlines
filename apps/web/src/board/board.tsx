import { Calendar, toDay, weekday, type DayNum, type ProjectState } from "@ganttlines/engine";
import type { BaselineTaskDto, CalendarDto, HighlightDto, ResourceDto } from "@ganttlines/protocol";
import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Bars, ROW_HEIGHT } from "./chart/bars";
import { ChartHeader } from "./chart/chart-header";
import { Dependencies } from "./chart/dependencies";
import { Shading } from "./chart/shading";
import { chartRange, DAY_WIDTH, Timeline } from "./chart/timeline";
import { today } from "./format";
import { ListHeader, ListRows } from "./list/task-list";
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
  calendarDto,
  resources,
  highlights,
  baseline,
}: {
  state: ProjectState;
  calendarDto: CalendarDto;
  resources: readonly ResourceDto[];
  highlights: readonly HighlightDto[];
  baseline: { mode: CompareMode; tasks: readonly BaselineTaskDto[] } | null;
}) {
  const { zoom, barStyle, showWeekends, listWidth, todayRequest, setListWidth } = useBoardView();
  const calendar = useMemo(() => new Calendar(calendarDto), [calendarDto]);
  const model = useMemo(() => boardModel(state, calendar, baseline), [state, calendar, baseline]);
  const resourceMap = useMemo(() => new Map(resources.map((resource) => [resource.id, resource])), [resources]);
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
  const [viewport, setViewport] = useState<Viewport>({ top: 0, left: 0, width: 1200, height: 800 });
  /** the day kept in place when the timeline changes (zoom, weekends) */
  const anchorDay = useRef<DayNum>(todayDay);
  const frame = useRef(0);

  const chartWidth = Math.max(viewport.width - listWidth, 0);
  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    anchorDay.current = timeline.dayAt(element.scrollLeft + chartWidth * ANCHOR);
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
      anchorDay.current = todayDay;
    }
    element.scrollLeft = Math.max(timeline.x(anchorDay.current) - chartWidth * ANCHOR, 0);
    setViewport(measure(element));
    // chartWidth is left out on purpose: resizing the window should not jump the chart.
  }, [timeline, todayRequest, todayDay]);

  const rowHeight = ROW_HEIGHT[barStyle];
  const firstRow = Math.max(Math.floor(viewport.top / rowHeight) - OVERSCAN_ROWS, 0);
  const lastRow = Math.min(Math.ceil((viewport.top + viewport.height) / rowHeight) + OVERSCAN_ROWS, model.rows.length);
  const shown = model.rows.slice(firstRow, lastRow);
  const days = timeline.daysBetween(viewport.left - OVERSCAN_PX, viewport.left + chartWidth + OVERSCAN_PX);
  const bodyHeight = Math.max(model.rows.length * rowHeight, viewport.height - HEADER_HEIGHT);
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
    <div className="flex h-full flex-col">
      {model.cycle ? (
        <p role="alert" className="border-b border-border bg-surface px-4 py-2 text-sm text-danger">
          These tasks' dependencies form a loop, so their dates can't be worked out.
        </p>
      ) : null}
      <div ref={scroller} onScroll={onScroll} data-testid="board-scroller" className="relative min-h-0 flex-1 overflow-auto">
        <div style={{ width: listWidth + timeline.width }}>
          <div className="sticky top-0 z-20 flex" style={{ height: HEADER_HEIGHT }}>
            <div className="sticky left-0 z-10 shrink-0 overflow-hidden border-r border-border bg-surface" style={{ width: listWidth }}>
              <ListHeader />
              {divider}
            </div>
            <ChartHeader timeline={timeline} zoom={zoom} stickyLeft={listWidth} days={days} highlights={highlightDays} todayDay={todayDay} />
          </div>
          <div className="flex" style={{ height: bodyHeight }}>
            <div role="treegrid" aria-label="Tasks" aria-rowcount={model.rows.length} className="sticky left-0 z-10 shrink-0 overflow-hidden border-r border-border bg-bg" style={{ width: listWidth, height: bodyHeight, ...grid }}>
              <ListRows rows={shown} firstRow={firstRow} rowHeight={rowHeight} numbers={model.numbers} calendar={calendar} resources={resourceMap} />
              {divider}
            </div>
            <div className="relative shrink-0 overflow-hidden" style={{ width: timeline.width, height: bodyHeight, ...grid }}>
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
              <div aria-hidden className="absolute top-0 w-0.5 bg-[var(--today)]" style={{ left: timeline.x(todayDay) + timeline.dayWidth / 2 - 1, height: bodyHeight }} />
              <Dependencies rows={model.rows} firstRow={firstRow} lastRow={lastRow} timeline={timeline} style={barStyle} />
              <Bars rows={shown} firstRow={firstRow} timeline={timeline} style={barStyle} resources={resourceMap} />
            </div>
          </div>
        </div>
        {model.rows.length === 0 ? <p className="absolute top-16 left-4 text-sm text-muted">No tasks yet.</p> : null}
      </div>
    </div>
  );
}
