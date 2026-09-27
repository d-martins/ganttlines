import { z } from "zod";

export const ROLES = ["admin", "editor", "viewer", "guest"] as const;
export type Role = (typeof ROLES)[number];

export const LIMITS = {
  nameMax: 100,
  emailMax: 254,
  passwordMin: 8,
  passwordMax: 200,
  projectNameMax: 200,
} as const;

const email = z.email().max(LIMITS.emailMax).transform((value) => value.toLowerCase());
const password = z.string().min(LIMITS.passwordMin).max(LIMITS.passwordMax);
const personName = z.string().trim().min(1).max(LIMITS.nameMax);
const projectName = z.string().trim().min(1).max(LIMITS.projectNameMax);

export const SetupBody = z.strictObject({ email, name: personName, password });
export const LoginBody = z.strictObject({ email, password: z.string().min(1).max(LIMITS.passwordMax) });
export const ChangePasswordBody = z.strictObject({
  currentPassword: z.string().min(1).max(LIMITS.passwordMax),
  newPassword: password,
});
export const CreateUserBody = z.strictObject({
  email,
  name: personName,
  role: z.enum(ROLES),
  /** create a matching team member (resource) linked to the user */
  createResource: z.boolean().default(true),
});
export const UpdateUserBody = z.strictObject({ name: personName.optional(), role: z.enum(ROLES).optional() });
export const CreateProjectBody = z.strictObject({ name: projectName });
export const UpdateProjectBody = z.strictObject({ name: projectName.optional(), archived: z.boolean().optional() });

export type SetupBody = z.infer<typeof SetupBody>;
export type LoginBody = z.infer<typeof LoginBody>;
export type ChangePasswordBody = z.infer<typeof ChangePasswordBody>;
export type CreateUserBody = z.input<typeof CreateUserBody>;
export type UpdateUserBody = z.infer<typeof UpdateUserBody>;
export type CreateProjectBody = z.infer<typeof CreateProjectBody>;
export type UpdateProjectBody = z.infer<typeof UpdateProjectBody>;

export interface UserDto {
  id: string;
  email: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
}

export interface ProjectDto {
  id: string;
  name: string;
  version: number;
  archived: boolean;
}

export interface ApiError {
  error: string;
  message: string;
}
