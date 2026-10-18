import type { Calendar } from "./calendar";
import type { DayNum } from "./date";
import type { ProjectState, RowId } from "./model";
import type { Schedule } from "./schedule";
import { buildTree, descendantLeafTasks, type Tree } from "./tree";

/**
 * Days a parent or section is worked: the distinct days on which at least one task inside it is
 * worked, each on its own person's calendar. A half day counts as a day; days a parent's bar is
 * only stretched over (by a finish link onto it) and milestones add nothing.
 */
export function workedDays(state: ProjectState, schedule: Schedule, calendar: Calendar, id: RowId, tree: Tree = buildTree(state)): number {
  const days = new Set<DayNum>();
  for (const leaf of descendantLeafTasks(tree, id)) {
    const span = schedule.get(leaf.id)?.span;
    if (!span || leaf.duration === 0) continue;
    for (let day = span.start; day <= span.end; day++) if (calendar.isWorkingDay(day, leaf.resourceId)) days.add(day);
  }
  return days.size;
}
