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
  /**
   * Working days, in half-day steps (0.5, 1, 2.5 …); 0 = milestone. A task fills the days it touches
   * (2.5 → three days). Ignored for parent tasks (dates roll up from children).
   */
  duration: number;
  /** Working days the task really took, when recorded — informational only, never moves the schedule. */
  actualDuration: number | null;
  resourceId: ResourceId | null;
  color: TaskColor;
  locked: boolean;
  predecessorId: RowId | null;
  /** Working days relative to the day after the predecessor ends (negative = overlap). */
  offset: number;
  description: string;
}

export type Row = SectionRow | TaskRow;

export interface ProjectState {
  readonly rows: Readonly<Record<RowId, Readonly<Row>>>;
}

export const TASK_DEFAULTS = {
  userStart: null,
  duration: 1,
  resourceId: null,
  color: "blue",
  locked: false,
  predecessorId: null,
  offset: 0,
  description: "",
  actualDuration: null,
} as const satisfies Partial<TaskRow>;
