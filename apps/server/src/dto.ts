import type { Project, User } from "@ganttlines/db";
import type { ProjectDto, UserDto } from "@ganttlines/protocol";

export function toUserDto(user: User, mustSetUpTwoFactor = false): UserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    twoFactor: user.totpEnabled,
    mustSetUpTwoFactor,
  };
}

export function toProjectDto(project: Project): ProjectDto {
  return { id: project.id, name: project.name, version: project.version, archived: project.archivedAt !== null };
}
