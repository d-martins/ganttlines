import type { Calendar } from "./calendar";
import { fromDay, type IsoDate } from "./date";
import type { ProjectState, RowId } from "./model";
import { computeSchedule } from "./schedule";
import { buildTree, isParentTask } from "./tree";

/** A task's dates and shape as a baseline saves them. */
export interface BaselineTask {
  rowId: RowId;
  /** how to draw it in the overlay: a bar, a parent bracket or a milestone diamond */
  kind: "task" | "parent" | "milestone";
  title: string;
  start: IsoDate;
  end: IsoDate;
  startsAfternoon: boolean;
  endsMidday: boolean;
}

/** The current computed dates of every scheduled task (what a baseline saves). */
export function baselineTasks(state: ProjectState, calendar: Calendar): BaselineTask[] {
  const schedule = computeSchedule(state, calendar);
  const tree = buildTree(state);
  const tasks: BaselineTask[] = [];
  for (const row of Object.values(state.rows)) {
    const span = schedule.get(row.id)?.span;
    if (row.kind !== "task" || !span) continue;
    const kind = isParentTask(tree, row) ? "parent" : row.duration === 0 ? "milestone" : "task";
    tasks.push({
      rowId: row.id,
      kind,
      title: row.title,
      start: fromDay(span.start),
      end: fromDay(span.end),
      startsAfternoon: span.startsAfternoon,
      endsMidday: span.endsMidday,
    });
  }
  return tasks;
}
