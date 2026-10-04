import type { TwoFactor } from "../auth/two-factor";
import type { TwoFactorPolicy } from "../auth/two-factor-policy";
import type { PasswordTokens } from "../auth/password-tokens";
import type { Mailer } from "../mail/mailer";
import type { FirstRun } from "../auth/first-run";
import type { Db } from "@ganttlines/db";
import type { FastifyReply } from "fastify";
import type { AccessService } from "../auth/access";
import type { LoginLimiter } from "../auth/login-limiter";
import { SESSION_COOKIE, type SessionStore } from "../auth/sessions";
import type { InstanceService } from "../calendar/instance-service";
import type { Config } from "../config";
import type { ProjectService } from "../projects/project-service";
import type { KeyedQueue } from "../queue";
import type { Hub } from "../realtime/hub";

/** Shared dependencies handed to every route module. */
export interface RouteContext {
  db: Db;
  config: Config;
  sessions: SessionStore;
  loginLimiter: LoginLimiter;
  instance: InstanceService;
  projects: ProjectService;
  hub: Hub;
  access: AccessService;
  /** throttles guessing of share-link tokens per client IP */
  shareLimiter: LoginLimiter;
  /** serialises highlight/baseline changes per project, so their live list broadcasts stay in order */
  boardQueue: KeyedQueue;
  /** creating the first admin (from settings, or in the browser with the setup code) */
  firstRun: FirstRun;
  /** outgoing email; null when SMTP isn't set up */
  mailer: Mailer | null;
  /** one-time "choose your password" links */
  passwordTokens: PasswordTokens;
  /** authenticator-app codes for two-factor sign-in */
  twoFactor: TwoFactor;
  /** who must use two-factor */
  twoFactorPolicy: TwoFactorPolicy;
}

export function setSessionCookie(reply: FastifyReply, config: Config, token: string, expires: Date): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.publicUrl.protocol === "https:",
    expires,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}
