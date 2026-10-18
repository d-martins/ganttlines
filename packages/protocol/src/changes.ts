import type { Change } from "@ganttlines/engine";

export interface CommandResultDto {
  /** project version after the command (unchanged when the command changed nothing) */
  version: number;
  changes: Change[];
}

export interface ChangeEntryDto {
  version: number;
  commandId: string;
  actor: { userId: string | null; label: string };
  changes: Change[];
}

/** Response of GET /api/projects/:id/changes?since=N — either the missing entries or "reload". */
export type ChangesDto = { version: number; entries: ChangeEntryDto[] } | { version: number; reload: true };
