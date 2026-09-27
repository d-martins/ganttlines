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
  /** Working days; 0 = milestone. Ignored for parent tasks (dates roll up from children). */
  duration: number;
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
  readonly rows: Readonly<Record<RowId, Row>>;
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
} as const satisfies Partial<TaskRow>;
