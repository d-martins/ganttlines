import type { User } from "@ganttlines/db";
import type { Role } from "@ganttlines/protocol";
import type { FastifyRequest } from "fastify";
import { forbidden, HttpError, unauthorized } from "../errors";

declare module "fastify" {
  interface FastifyRequest {
    /** Signed-in user, resolved from the session cookie (null when anonymous). */
    user: User | null;
    sessionToken: string | null;
  }
}

const RANK: Record<Role, number> = { guest: 0, viewer: 1, editor: 2, admin: 3 };

/**
 * Returns the signed-in user or throws 401/403. Users who must change their password can only
 * reach routes that pass `allowPendingPasswordChange`.
 */
export function requireUser(
  request: FastifyRequest,
  minRole: Role = "guest",
  { allowPendingPasswordChange = false } = {},
): User {
  const user = request.user;
  if (!user) throw unauthorized();
  if (user.mustChangePassword && !allowPendingPasswordChange) {
    throw new HttpError(403, "password_change_required", "Please change your password first");
  }
  if (RANK[user.role] < RANK[minRole]) throw forbidden();
  return user;
}
