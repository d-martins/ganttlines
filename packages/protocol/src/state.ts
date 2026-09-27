import type { Row } from "@ganttlines/engine";
import type { ProjectDto } from "./api";

/** Response of GET /api/projects/:id/state — everything the board needs to render a project. */
export interface ProjectStateDto {
  project: ProjectDto;
  rows: Row[];
}
