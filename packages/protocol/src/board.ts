import { MAX_DATE, MIN_DATE } from "@ganttlines/engine";
import { z } from "zod";

export const BOARD_LIMITS = { commentMax: 10_000, highlightLabelMax: 100, baselineNameMax: 100, activityPageMax: 100 } as const;

const date = z.iso.date().refine((value) => value >= MIN_DATE && value <= MAX_DATE, `Dates must be between ${MIN_DATE} and ${MAX_DATE}`);
const body = z.string().trim().min(1).max(BOARD_LIMITS.commentMax);

export const CommentBody = z.strictObject({ taskId: z.uuid(), body });
export const EditCommentBody = z.strictObject({ body });
export const HighlightBody = z.strictObject({
  date,
  label: z.string().trim().max(BOARD_LIMITS.highlightLabelMax).default(""),
  color: z.string().regex(/^#[0-9a-f]{6}$/i, "Colors are #rrggbb"),
});
export const CreateBaselineBody = z.strictObject({ name: z.string().trim().min(1).max(BOARD_LIMITS.baselineNameMax) });

export type CommentBody = z.infer<typeof CommentBody>;
export type EditCommentBody = z.infer<typeof EditCommentBody>;
export type HighlightBody = z.input<typeof HighlightBody>;
export type CreateBaselineBody = z.infer<typeof CreateBaselineBody>;

export interface CommentDto {
  id: string;
  taskId: string;
  author: { userId: string | null; label: string };
  /** empty once deleted */
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
}

export interface HighlightDto {
  id: string;
  date: string;
  label: string;
  color: string;
}

export interface BaselineDto {
  id: string;
  name: string;
  createdAt: string;
  createdBy: string;
}

export interface BaselineTaskDto {
  rowId: string;
  title: string;
  start: string;
  end: string;
}

/** Response of GET /api/baselines/:id — the saved dates, for switching to or overlaying the baseline. */
export interface BaselineSnapshotDto {
  baseline: BaselineDto;
  tasks: BaselineTaskDto[];
}

export interface ActivityEntryDto {
  version: number;
  commandId: string;
  /** command name, e.g. "moveTask", "undo" */
  name: string;
  actor: { userId: string | null; label: string; linkId: string | null };
  createdAt: string;
  /** rows this change touched */
  rowIds: string[];
}

/** Response of GET /api/projects/:id/activity — newest first; pass `nextBefore` as `before` for more. */
export interface ActivityDto {
  entries: ActivityEntryDto[];
  nextBefore: number | null;
}
