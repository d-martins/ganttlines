import type { User } from "@ganttlines/db";
import type { Role } from "@ganttlines/protocol";
import type { FastifyRequest } from "fastify";
import { forbidden, HttpError, unauthorized } from "../errors";

declare module "fastify" {
  interface FastifyRequest {
    /** Signed-in user, resolved from the session cookie (null when anonymous). */
    user: User | null;
    sessionToken: string | null;
    /** what the signed-in user must do before using the app, if anything */
    pendingStep: PendingStep | null;
  }
}

/** Steps a signed-in user must take first: choose their own password, or set up two-factor. */
export type PendingStep = "change_password" | "set_up_two_factor";

export function pendingStepError(step: PendingStep): HttpError {
  return step === "change_password"
    ? new HttpError(403, "password_change_required", "Please change your password first")
    : new HttpError(403, "two_factor_setup_required", "Please set up two-factor sign-in first");
}

const RANK: Record<Role, number> = { guest: 0, viewer: 1, editor: 2, admin: 3 };

/**
 * Returns the signed-in user or throws 401/403. Users with a pending step (see `PendingStep`) can
 * only reach routes that allow it.
 */
export function requireUser(
  request: FastifyRequest,
  minRole: Role = "guest",
  { allowPendingPasswordChange = false, allowTwoFactorSetup = false } = {},
): User {
  const user = request.user;
  if (!user) throw unauthorized();
  const step = request.pendingStep;
  if (step === "change_password" && !allowPendingPasswordChange) throw pendingStepError(step);
  if (step === "set_up_two_factor" && !allowTwoFactorSetup) throw pendingStepError(step);
  if (RANK[user.role] < RANK[minRole]) throw forbidden();
  return user;
}
