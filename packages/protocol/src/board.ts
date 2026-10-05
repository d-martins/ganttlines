import { MAX_DATE, MIN_DATE, type RowChange } from "@ganttlines/engine";
import { z } from "zod";

export const BOARD_LIMITS = { commentMax: 10_000, commentsPerTask: 1000, highlightLabelMax: 100, baselineNameMax: 100, activityPageMax: 100, commentPageMax: 100 } as const;

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
  /** whether the person receiving this wrote it (so the UI can offer edit/delete) */
  mine: boolean;
}

/** Response of GET /api/projects/:id/comments — newest first; pass `nextBefore` as `before` for older ones. */
export interface CommentsDto {
  comments: CommentDto[];
  nextBefore: string | null;
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
  /** how to draw it in the overlay: a bar, a parent bracket or a milestone diamond */
  kind: "task" | "parent" | "milestone";
  title: string;
  start: string;
  end: string;
  /** starts in the afternoon of `start` (absent in baselines saved before half-day scheduling) */
  startsAfternoon?: boolean;
  /** ends at midday of `end` */
  endsMidday?: boolean;
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
  /** what changed (only the filtered row's changes when `rowId` is given) */
  changes: RowChange[];
}

/** Response of GET /api/projects/:id/activity — newest first; pass `nextBefore` as `before` for more. */
export interface ActivityDto {
  entries: ActivityEntryDto[];
  nextBefore: number | null;
}
