import { applyCommand, toDay, weekday, type Calendar, type DayNum, type ProjectState } from "@ganttlines/engine";
import { useShallow } from "zustand/react/shallow";
import type { BaselineTaskDto, CalendarDto, HighlightDto, ResourceDto } from "@ganttlines/protocol";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { BoardSearch } from "../router";
import { extent, ROW_HEIGHT } from "./chart/bars";
import { ChartRows, EDGE_RIGHT, edgeScrollTarget } from "./chart/chart-rows";
import { DayMenu } from "./chart/day-menu";
import { useChartDrag } from "./chart/drag";
import { ChartHeader } from "./chart/chart-header";
import { Dependencies } from "./chart/dependencies";
import { aimedMilestones, MilestoneLines } from "./chart/milestone-lines";
import { Shading } from "./chart/shading";
import { chartRange, scaleOf, Timeline, zoomStep } from "./chart/timeline";
import { today } from "./format";
import { useBoard } from "./board-context";
import { useCollapse, useCollapsed } from "./collapse";
import { FilterBar } from "./filter-bar";
import { filterRows, filtersFromSearch, hasTag, knownFilters, searchFromFilters, toggleTag, withFilters, type BoardFilters } from "./filters";
import type { TagFilter } from "./chart/tag-chips";
import { useLinger } from "./linger";
import { ListColumnHeaders, ListHeader, ListRows, useListKeys } from "./list/task-list";
import { useSelection } from "./selection";
import { boardModel, type CompareMode } from "./model";
import { listContentWidth, LIST_WIDTH, mostRowActions, rowActionsWidth, SLIP_COLUMN, useBoardView } from "./view-store";
import { useCriticalPath } from "./critical-path-view";
import { boardSchedule } from "./slack";

type DetailsPanelType = typeof import("./panel/details-panel").DetailsPanel;
/** The details panel brings the rich-text editor along: a separate download, fetched once a board is shown. */
let loadedPanel: DetailsPanelType | null = null;
function useDetailsPanel(): DetailsPanelType | null {
  const [panel, setPanel] = useState(() => loadedPanel);
  useEffect(() => {
    if (panel) return;
    let current = true;
    void import("./panel/details-panel").then((module) => {
      loadedPanel = module.DetailsPanel;
      if (current) setPanel(() => module.DetailsPanel);
    });
    return () => {
      current = false;
    };
  }, [panel]);
  return panel;
}

const HEADER_HEIGHT = 48;
const OVERSCAN_ROWS = 10;
const OVERSCAN_PX = 600;
/** Room below the board's scroll area for its own sideways scrollbar, kept out of view (thicker than any browser's). */
const HIDDEN_SCROLLBAR = 20;
/** Where "today" (and the day kept in place when zooming) sits: a third into the chart. */
const ANCHOR = 1 / 3;
/** how long a row that stopped matching stays after it is no longer selected */
const LINGER_MS = 5000;
const NO_ROWS: ReadonlySet<string> = new Set();

interface Viewport {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** The size of the scroll area; jsdom reports 0, so tests get a sensible default. */
/**
 * Scrolling re-renders the board only when the rows and days it draws would change: every few rows or few hundred
 * pixels, well inside the overscan, so nothing undrawn comes into view in between.
 */
const sameWindow = (a: Viewport, b: Viewport, rowHeight: number) =>
  a.width === b.width &&
  a.height === b.height &&
  Math.floor(a.top / (rowHeight * (OVERSCAN_ROWS / 2))) === Math.floor(b.top / (rowHeight * (OVERSCAN_ROWS / 2))) &&
  Math.floor(a.left / (OVERSCAN_PX / 2)) === Math.floor(b.left / (OVERSCAN_PX / 2));

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
  const { dayWidth, barStyle, showWeekends, listWidth: chosenWidth, todayRequest, setListWidth } = useBoardView();
  const { canEdit, canEditCalendar, sync } = useBoard();
  // The "Can slip" column gets its room without touching the width chosen for the list.
  const critical = useCriticalPath(sync.projectId);
  const slipRoom = critical ? SLIP_COLUMN : 0;
  const listWidth = Math.min(chosenWidth + slipRoom, LIST_WIDTH.max + slipRoom);
  // Narrower than its columns, the list scrolls sideways under its own scrollbar.
  // The row actions column is as wide as the most actions any row shows.
  const actions = useMemo(() => mostRowActions(Object.values(state.rows), canEdit), [state.rows, canEdit]);
  const listContent = listContentWidth(slipRoom > 0, actions);
  // (its right border takes a pixel of its width)
  const listOver = listContent > listWidth ? listContent - listWidth + 1 : 0;
  // Scrolling sets --list-x on the list and its headings directly: the board doesn't re-render while the list scrolls.
  const listScroll = useRef(0);
  const listBar = useRef<HTMLDivElement>(null);
  const applyListX = useCallback(() => {
    const x = Math.min(listScroll.current, listOver);
    scroller.current?.querySelectorAll<HTMLElement>('[data-list-header], [role="treegrid"]').forEach((element) => element.style.setProperty("--list-x", `${x}px`));
  }, [listOver]);
  // A narrower overflow clamps the offset.
  useLayoutEffect(applyListX, [applyListX]);
  const listVars = { ["--list-over" as string]: `${listOver}px`, ["--list-content" as string]: `${listContent}px`, ["--actions-width" as string]: `${rowActionsWidth(actions)}px` };
  const collapsed = useCollapsed(sync.projectId);
  // Collapsed rows deleted since are forgotten (once the board has rows to compare with).
  useEffect(() => {
    if (Object.keys(state.rows).length > 0) useCollapse.getState().prune(sync.projectId, (id) => id in state.rows);
  }, [state.rows, sync.projectId]);
  // While a bar is dragged, show the board as the drop would leave it (successors pushed and all).
  const dragCommand = useChartDrag((store) => store.drag?.command ?? null);
  const barMenuOpen = useChartDrag((store) => store.menuFor !== null);
  const displayed = useMemo(() => {
    if (!dragCommand) return state;
    const result = applyCommand(state, calendar, dragCommand);
    return result.ok ? result.state : state;
  }, [state, calendar, dragCommand]);
  // The filters live in the address (shared links open filtered the same way).
  const search = useSearch({ strict: false }) as BoardSearch;
  const navigate = useNavigate();
  const filterKey = JSON.stringify(searchFromFilters(filtersFromSearch(search)));
  const filters = useMemo(() => filtersFromSearch(JSON.parse(filterKey) as BoardSearch), [filterKey]);
  const updateFilters = useCallback(
    (change: (current: BoardFilters) => BoardFilters) =>
      void navigate({ to: ".", search: (previous: BoardSearch) => withFilters(previous, change(filtersFromSearch(previous))), replace: true }),
    [navigate],
  );
  const tagFilter = useMemo<TagFilter>(() => ({ active: (tag) => hasTag(filters, tag), toggle: (tag) => updateFilters((current) => toggleTag(current, tag)) }), [filters, updateFilters]);
  const team = useMemo(() => new Set(resources.map((resource) => resource.id)), [resources]);
  const { selectedId, select, centerRequest } = useSelection(useShallow(({ selectedId, select, centerRequest }) => ({ selectedId, select, centerRequest })));
  // A row an edit takes out of the filter stays while it is selected, and a little after.
  const matches = useMemo(() => filterRows(displayed, filters, team)?.matches ?? NO_ROWS, [displayed, filters, team]);
  const shownMatches = useLinger(matches, selectedId, LINGER_MS, filterKey);
  const model = useMemo(
    () => boardModel(displayed, calendar, baseline, filters, collapsed, team, shownMatches),
    [displayed, calendar, baseline, filters, collapsed, team, shownMatches],
  );
  const milestones = useMemo(() => aimedMilestones(displayed, () => boardSchedule(displayed, calendar), model.rows), [displayed, calendar, model.rows]);
  const known = useMemo(() => knownFilters(state, filters, team), [state, filters, team]);
  const DetailsPanel = useDetailsPanel();
  const onListKey = useListKeys(model.rows, model.filtering);
  const todayDay = today();
  const highlightDays = useMemo(() => highlights.map((highlight) => ({ day: toDay(highlight.date), highlight })), [highlights]);
  // Holiday names by day, for the date header (people-specific ones say so).
  const holidayNames = useMemo(() => {
    const names = new Map<DayNum, string[]>();
    for (const holiday of calendarDto.holidays) {
      const name = holiday.target.all ? holiday.name : `${holiday.name} (some people)`;
      for (let day = toDay(holiday.startDate); day <= toDay(holiday.endDate); day++) names.set(day, [...(names.get(day) ?? []), name]);
    }
    return names;
  }, [calendarDto.holidays]);

  const { first, last } = useMemo(() => {
    // Milestones too: a line for one whose row is hidden still has to land on its date.
    const days: DayNum[] = [...highlightDays.map(({ day }) => day), ...milestones.map(({ day }) => day)];
    for (const { span, ghost } of model.rows) {
      if (span) days.push(span.start, span.end);
      if (ghost) days.push(ghost.span.start, ghost.span.end);
    }
    return chartRange(days, todayDay);
  }, [model, milestones, highlightDays, todayDay]);
  const timeline = useMemo(() => {
    const working = new Set(calendarDto.workingWeekdays);
    const hidden = showWeekends ? undefined : (day: DayNum) => !working.has(weekday(day));
    return new Timeline(first, last, dayWidth, hidden);
  }, [first, last, dayWidth, showWeekends, calendarDto.workingWeekdays]);

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const chartBar = useRef<HTMLDivElement>(null);
  const chartBody = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ top: 0, left: 0, width: 1200, height: 800 });
  /**
   * The point kept in place when the timeline changes (zoom, weekends, the range growing during a
   * drag): a day plus how far into it, as a fraction of a column. Keeping the fraction matters:
   * rounding to the day's start on every change made the chart creep backwards while dragging.
   */
  const anchor = useRef<{ day: DayNum; fraction: number }>({ day: todayDay, fraction: 0.5 });
  /** Where on the chart the anchor goes after the next change (the pointer, when zooming with the wheel); otherwise ANCHOR. */
  const anchorAt = useRef<number | null>(null);
  const frame = useRef(0);

  const chartWidth = Math.max(viewport.width - listWidth, 0);
  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    // How far the chart has scrolled under the list (bar titles move along by CSS), and its scrollbar follows; straight to the DOM.
    content.current?.style.setProperty("--chart-hidden", `${element.scrollLeft}px`);
    if (chartBar.current && chartBar.current.scrollLeft !== element.scrollLeft) chartBar.current.scrollLeft = element.scrollLeft;
    const x = element.scrollLeft + chartWidth * ANCHOR;
    const day = timeline.dayAt(x);
    anchor.current = { day, fraction: Math.min(Math.max((x - timeline.x(day)) / timeline.dayWidth, 0), 1) };
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setViewport((previous) => (sameWindow(previous, measure(element), rowHeight) ? previous : measure(element))));
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
    element.scrollLeft = Math.max(timeline.x(day) + fraction * timeline.dayWidth - (anchorAt.current ?? chartWidth * ANCHOR), 0);
    anchorAt.current = null;
    setViewport(measure(element));
    // chartWidth is left out on purpose: resizing the window should not jump the chart.
  }, [timeline, todayRequest, todayDay]);

  // Ctrl/⌘ + the scroll wheel zooms around the pointer (a native listener: React's wheel events can't stop the page zooming).
  const wheelState = useRef({ timeline, dayWidth, listWidth });
  wheelState.current = { timeline, dayWidth, listWidth };
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    // Deltas add up: a mouse notch (~100 px) is one step; a trackpad pinch sends many small ones.
    const total = { sum: 0, at: 0 };
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.deltaY === 0) return;
      const { timeline: current, dayWidth: width, listWidth: list } = wheelState.current;
      const body = element.querySelector("[data-chart-body]");
      // Anywhere on the board: the chart zooms, around the pointer or the nearest of it, and never the page.
      if (!body) return;
      event.preventDefault();
      if (event.timeStamp - total.at > 150) total.sum = 0;
      total.at = event.timeStamp;
      total.sum += event.deltaY * (event.deltaMode === 1 ? 16 : 1);
      if (Math.abs(total.sum) < 100) return;
      const direction = total.sum < 0 ? 1 : -1;
      total.sum = 0;
      const next = zoomStep(width, direction);
      if (next === width) return;
      const x = event.clientX - body.getBoundingClientRect().left;
      const day = current.dayAt(x);
      anchor.current = { day, fraction: Math.min(Math.max((x - current.x(day)) / current.dayWidth, 0), 1) };
      anchorAt.current = Math.max(event.clientX - element.getBoundingClientRect().left - list, 0);
      useBoardView.getState().setDayWidth(next);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    // Sideways over the list: the list scrolls, not the chart, while its columns don't fit.
    const onListWheel = (event: WheelEvent) => {
      const bar = listBar.current;
      if (!bar || Math.abs(event.deltaX) <= Math.abs(event.deltaY) || event.ctrlKey || event.metaKey) return;
      if (!(event.target instanceof Element) || !event.target.closest('[role="treegrid"], [data-list-header]')) return;
      event.preventDefault();
      bar.scrollLeft += event.deltaX;
    };
    element.addEventListener("wheel", onListWheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("wheel", onListWheel);
    };
  }, []);

  const rowHeight = ROW_HEIGHT[barStyle];
  const firstRow = Math.max(Math.floor(viewport.top / rowHeight) - OVERSCAN_ROWS, 0);
  const lastRow = Math.min(Math.ceil((viewport.top + viewport.height) / rowHeight) + OVERSCAN_ROWS, model.rows.length);
  const shown = model.rows.slice(firstRow, lastRow);
  const days = timeline.daysBetween(viewport.left - OVERSCAN_PX, viewport.left + chartWidth + OVERSCAN_PX);
  // One spare row under the last task holds "+ Add task / + Add section"; below it, room to scroll the end up to mid-screen.
  const visibleHeight = Math.max(viewport.height - HEADER_HEIGHT, 0);
  const bodyHeight = Math.max((model.rows.length + (canEdit ? 1 : 0)) * rowHeight + Math.round(visibleHeight / 2), visibleHeight);
  const selectedIndex = model.rows.findIndex((entry) => entry.row.id === selectedId);

  // Bring a row's bar into view when asked (Show on chart, or a double-click): its start lands where the left edge
  // arrow's click puts it, a few days in from the task list, so it reads from the beginning.
  useEffect(() => {
    const element = scroller.current;
    const entry = centerRequest ? model.rows.find((candidate) => candidate.row.id === centerRequest.id) : undefined;
    if (!element || !entry?.span) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const left = edgeScrollTarget("left", extent(entry.kind, entry.span, timeline, barStyle), timeline.dayWidth, chartWidth);
    if (typeof element.scrollTo === "function") element.scrollTo({ left, behavior: reduce ? "auto" : "smooth" });
    else element.scrollLeft = left;
    // Only a new request moves the chart; later edits to the row don't (model/timeline are read at request time).
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
  // Faint lines between days (between weeks when zoomed out; none by month).
  const scale = scaleOf(dayWidth);
  const shownPerWeek = showWeekends ? 7 : calendarDto.workingWeekdays.length;
  const column = scale === "day" ? dayWidth : scale === "week" ? dayWidth * shownPerWeek : 0;
  const firstMonday = timeline.first + ((8 - weekday(timeline.first)) % 7);
  const columnOffset = column > 0 && scale === "week" ? timeline.x(firstMonday) % column : 0;
  // The list has lines between rows; the chart, faint lines between its columns only.
  const listGrid = { backgroundImage: `linear-gradient(to bottom, transparent ${rowHeight - 1}px, var(--grid) ${rowHeight - 1}px)`, backgroundSize: `100% ${rowHeight}px` };
  const chartGrid =
    column > 0
      ? { backgroundImage: "linear-gradient(to right, var(--grid-day) 1px, transparent 1px)", backgroundSize: `${column}px 100%`, backgroundPosition: `${columnOffset}px 0` }
      : {};

  const startResize = (event: ReactPointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = chosenWidth;
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
      <FilterBar state={state} resources={resources} filters={filters} known={known} filtering={model.filtering} count={model.count} onUpdate={updateFilters} />
      {model.cycle ? (
        <p role="alert" className="border-b border-border bg-surface px-4 py-2 text-sm text-danger">
          These tasks' dependencies form a loop, so their dates can't be worked out.
        </p>
      ) : null}
      {/* The board scrolls natively both ways, but its own sideways scrollbar would run under the list: the scroll area
          reaches HIDDEN_SCROLLBAR past the bottom, out of view, and each pane has its own bar instead. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={scroller} onScroll={onScroll} data-testid="board-scroller" className="absolute inset-x-0 top-0 overflow-auto" style={{ bottom: -HIDDEN_SCROLLBAR }}>
          <div ref={content} style={{ width: listWidth + timeline.width }}>
            <div className="sticky top-0 z-20 flex" style={{ height: HEADER_HEIGHT }}>
              <div className="sticky left-0 z-10 shrink-0 overflow-clip border-r border-[var(--list-edge)] bg-surface shadow-[var(--list-shadow)]" data-list-header style={{ width: listWidth, ...listVars }}>
                <ListHeader filtering={model.filtering} pinned={listOver > 0} />
                {divider}
              </div>
              <ChartHeader timeline={timeline} zoom={scaleOf(dayWidth)} stickyLeft={listWidth} days={days} highlights={highlightDays} holidays={holidayNames} todayDay={todayDay} milestones={milestones} />
            </div>
            <div className="flex" style={{ height: bodyHeight }}>
              <div
                role="treegrid"
                aria-label="Tasks"
                aria-rowcount={model.rows.length + 1}
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
                className="sticky left-0 z-10 shrink-0 overflow-clip border-r border-[var(--list-edge)] bg-surface shadow-[var(--list-shadow)] outline-none focus:outline-none focus-visible:outline-none"
                style={{ width: listWidth, height: bodyHeight, ...listGrid, ...listVars }}
              >
                <ListColumnHeaders />
                <ListRows rows={shown} allRows={model.rows} firstRow={firstRow} rowHeight={rowHeight} numbers={model.numbers} filtering={model.filtering} pinned={listOver > 0} />
                {divider}
              </div>
              <DayMenu
                projectId={sync.projectId}
                // React events from the bar's menu bubble here through its portal: a right-click or long-press in it isn't one on a day.
                enabled={canEdit && !barMenuOpen}
                canEditCalendar={canEditCalendar}
                dayAt={(clientX) => timeline.dayAt(clientX - (chartBody.current?.getBoundingClientRect().left ?? 0))}
                highlights={highlightDays}
                resources={resources}
              >
              <div
                ref={chartBody}
                data-chart-body
                // clip, not hidden: section names stick to the scroll area, which a hidden overflow would cut them off from
                className="relative shrink-0 overflow-clip"
                style={{ width: timeline.width, height: bodyHeight, ["--list-width" as string]: `${listWidth}px`, ["--edge-right" as string]: `${EDGE_RIGHT}px`, ...chartGrid }}
              >
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
                <MilestoneLines milestones={milestones} timeline={timeline} height={bodyHeight} />
                <Dependencies rows={model.rows} links={model.links} firstRow={firstRow} lastRow={lastRow} timeline={timeline} style={barStyle} />
                <ChartRows rows={shown} allRows={model.rows} firstRow={firstRow} timeline={timeline} style={barStyle} tagFilter={tagFilter} filtering={model.filtering} scroller={scroller} listWidth={listWidth} />
              </div>
              </DayMenu>
            </div>
            {/* Each pane's own sideways scrollbar: the list's under the list (while its columns don't fit), the chart's under the chart. */}
            <div className="pointer-events-none sticky left-0 z-20 flex" style={{ bottom: HIDDEN_SCROLLBAR, width: listWidth + chartWidth }}>
              {listOver > 0 ? (
                <div className="pointer-events-auto absolute bottom-0 left-0 border-t border-r border-[var(--list-edge)] bg-surface" style={{ width: listWidth }}>
                  <div
                    ref={listBar}
                    data-testid="list-scrollbar"
                    className="list-scrollbar overflow-x-auto"
                    onScroll={(event) => {
                      listScroll.current = event.currentTarget.scrollLeft;
                      applyListX();
                    }}
                  >
                    <div style={{ width: listContent, height: 8 }} />
                  </div>
                </div>
              ) : null}
              <div className="pointer-events-auto border-t border-[var(--list-edge)] bg-surface" style={{ marginLeft: listWidth, width: chartWidth }}>
                <div
                  ref={chartBar}
                  data-testid="chart-scrollbar"
                  className="list-scrollbar overflow-x-auto"
                  onScroll={(event) => {
                    const element = scroller.current;
                    if (element && element.scrollLeft !== event.currentTarget.scrollLeft) element.scrollLeft = event.currentTarget.scrollLeft;
                  }}
                >
                  <div style={{ width: timeline.width, height: 8 }} />
                </div>
              </div>
            </div>
          </div>
          <div style={{ height: HIDDEN_SCROLLBAR }} />
          {model.rows.length === 0 ? <p className="absolute top-16 left-4 text-sm text-muted">No tasks yet.</p> : null}
        </div>
      </div>
      {DetailsPanel ? <DetailsPanel numbers={model.numbers} filtering={model.filtering} /> : null}
    </div>
  );
}
