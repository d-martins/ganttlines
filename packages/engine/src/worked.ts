import type { Calendar } from "./calendar";
import type { DayNum } from "./date";
import type { ProjectState, RowId, TaskRow } from "./model";
import type { Schedule } from "./schedule";
import { buildTree, childrenOf, descendantLeafTasks, isParentTask, type Tree } from "./tree";

/** The days a leaf task is worked, on its own person's calendar (none when unscheduled or a milestone). */
function leafDays(leaf: TaskRow, schedule: Schedule, calendar: Calendar, into: Set<DayNum>): Set<DayNum> {
  const span = schedule.get(leaf.id)?.span;
  if (!span || leaf.duration === 0) return into;
  for (let day = span.start; day <= span.end; day++) if (calendar.isWorkingDay(day, leaf.resourceId)) into.add(day);
  return into;
}

/**
 * Days a parent or section is worked: the distinct days on which at least one task inside it is
 * worked, each on its own person's calendar. A half day counts as a day; days a parent's bar is
 * only stretched over (by a finish link onto it) and milestones add nothing.
 */
export function workedDays(state: ProjectState, schedule: Schedule, calendar: Calendar, id: RowId, tree: Tree = buildTree(state)): number {
  const days = new Set<DayNum>();
  for (const leaf of descendantLeafTasks(tree, id)) leafDays(leaf, schedule, calendar, days);
  return days.size;
}

/**
 * `workedDays` of every parent and section, in one pass up the tree: each leaf task's days are
 * found once and joined into its ancestors' (the smaller sets into the larger).
 */
export function workedDaysOfAll(state: ProjectState, schedule: Schedule, calendar: Calendar, tree: Tree = buildTree(state)): Map<RowId, number> {
  const counts = new Map<RowId, number>();
  const daysBelow = (id: RowId | null): Set<DayNum> => {
    let days = new Set<DayNum>();
    for (const child of childrenOf(tree, id)) {
      const childDays = child.kind === "task" && !isParentTask(tree, child) ? leafDays(child, schedule, calendar, new Set()) : daysBelow(child.id);
      const [small, large] = childDays.size > days.size ? [days, childDays] : [childDays, days];
      for (const day of small) large.add(day);
      days = large;
    }
    if (id !== null) counts.set(id, days.size);
    return days;
  };
  daysBelow(null);
  return counts;
}
