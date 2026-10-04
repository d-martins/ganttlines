import { SHARE_TOKEN_HEADER } from "@ganttlines/protocol";
import type { FastifyRequest } from "fastify";
import { HttpError } from "../errors";
import type { AccessService, Credentials, ProjectAccess } from "./access";
import { VISITOR_COOKIE } from "./access";
import type { LoginLimiter } from "./login-limiter";

export interface AccessContext {
  access: AccessService;
  /** throttles guessing of share-link tokens per client IP */
  shareLimiter: LoginLimiter;
}

export function credentialsOf(request: FastifyRequest, access: AccessService, shareToken?: string | null): Credentials {
  const header = request.headers[SHARE_TOKEN_HEADER];
  return {
    user: request.user,
    pendingStep: request.pendingStep,
    shareToken: shareToken ?? (typeof header === "string" ? header : null),
    visitor: access.readVisitor(request.cookies[VISITOR_COOKIE]),
  };
}

export async function requireProjectAccess(
  request: FastifyRequest,
  context: AccessContext,
  projectId: string,
  level: "view" | "edit",
): Promise<ProjectAccess> {
  const credentials = credentialsOf(request, context.access);
  return throttleShareTokens(request, context, credentials, () => context.access.require(credentials, projectId, level));
}

export async function requireInstanceRead(
  request: FastifyRequest,
  context: AccessContext,
  shareToken?: string | null,
): Promise<"member" | "link"> {
  const credentials = credentialsOf(request, context.access, shareToken);
  return throttleShareTokens(request, context, credentials, () => context.access.requireInstanceRead(credentials));
}

/**
 * Unknown share tokens (404) count as failures per client IP; too many → 429 (like failed logins).
 * Revoked links (410) do not count, so reconnecting tabs cannot lock out everyone behind one IP.
 */
export async function throttleShareTokens<T>(
  request: FastifyRequest,
  { shareLimiter }: AccessContext,
  credentials: Credentials,
  work: () => Promise<T>,
): Promise<T> {
  if (!credentials.shareToken) return work();
  const keys = [`share:${request.ip}`];
  if (shareLimiter.isBlocked(keys)) throw new HttpError(429, "too_many_attempts", "Too many invalid links, try again in a few minutes");
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) shareLimiter.recordFailure(keys);
    throw error;
  }
}
