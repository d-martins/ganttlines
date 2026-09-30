import type { ResourceId } from "./calendar";
import type { IsoDate } from "./date";

export type RowId = string;

export const TASK_COLORS = ["blue", "purple", "pink", "red", "orange", "yellow", "green", "teal", "gray"] as const;
export type TaskColor = (typeof TASK_COLORS)[number];

interface RowBase {
  id: RowId;
  title: string;
  parentId: RowId | null;
  /** fractional-indexing key; siblings sort by plain string comparison */
  position: string;
  collapsed: boolean;
}

export interface SectionRow extends RowBase {
  kind: "section";
}

export interface TaskRow extends RowBase {
  kind: "task";
  /** Date the user last placed the task on; null = not scheduled yet. */
  userStart: IsoDate | null;
  /** Placed on the afternoon of `userStart` rather than its morning. */
  startsAfternoon: boolean;
  /**
   * Working days, in half-day steps (0.5, 1, 2.5 …); 0 = milestone. Scheduled in half days: 2.5 days
   * from a morning end at midday of the third day. Ignored for parent tasks (dates roll up from children).
   */
  duration: number;
  /** Working days the task really took, when recorded — informational only, never moves the schedule. */
  actualDuration: number | null;
  resourceId: ResourceId | null;
  color: TaskColor;
  locked: boolean;
  predecessorId: RowId | null;
  /** Working days (half-day steps) relative to the half day after the predecessor ends (negative = overlap). */
  offset: number;
  description: string;
}

export type Row = SectionRow | TaskRow;

export interface ProjectState {
  readonly rows: Readonly<Record<RowId, Readonly<Row>>>;
}

export const TASK_DEFAULTS = {
  userStart: null,
  startsAfternoon: false,
  duration: 1,
  resourceId: null,
  color: "blue",
  locked: false,
  predecessorId: null,
  offset: 0,
  description: "",
  actualDuration: null,
} as const satisfies Partial<TaskRow>;
