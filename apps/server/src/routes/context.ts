import type { TwoFactor } from "../auth/two-factor";
import type { TwoFactorPolicy } from "../auth/two-factor-policy";
import type { OAuthClients } from "../oauth/clients";
import type { OAuthGrants } from "../oauth/grants";
import type { McpSettings } from "../oauth/mcp-settings";
import type { PasswordTokens } from "../auth/password-tokens";
import type { Mailer } from "../mail/mailer";
import type { FirstRun } from "../auth/first-run";
import type { Db } from "@ganttlines/db";
import type { FastifyReply } from "fastify";
import type { AccessService } from "../auth/access";
import type { Limiter } from "../auth/limiter";
import { SESSION_COOKIE, type SessionStore } from "../auth/sessions";
import type { InstanceService } from "../calendar/instance-service";
import type { TeamEdits } from "../calendar/team-edits";
import type { Cluster } from "../cluster/types";
import type { Config } from "../config";
import type { ProjectService } from "../projects/project-service";
import type { KeyedQueue } from "../queue";
import type { Hub } from "../realtime/hub";
import type { Live } from "../realtime/live";
import type { Presence } from "../realtime/presence";

/** Shared dependencies handed to every route module. */
export interface RouteContext {
  db: Db;
  config: Config;
  /** how copies share state (no-ops in single mode) */
  cluster: Cluster;
  sessions: SessionStore;
  loginLimiter: Limiter;
  instance: InstanceService;
  projects: ProjectService;
  hub: Hub;
  /** what this copy tells its browsers, told to every copy */
  live: Live;
  /** who is viewing each board, across copies */
  presence: Presence;
  access: AccessService;
  /** throttles guessing of share-link tokens per client IP */
  shareLimiter: Limiter;
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
  /** AI access over MCP: the admins' switch and allowed tool groups */
  mcpSettings: McpSettings;
  /** AI apps (registered, or known by their metadata address) */
  oauthClients: OAuthClients;
  /** people's approvals for AI apps: codes and tokens */
  oauthGrants: OAuthGrants;
  /** throttles app registrations per client IP */
  registerLimiter: Limiter;
  /** requests per AI app connection (per minute) */
  mcpBudget: Limiter;
  /** changes to the team calendar (people, locations, holidays, time off) */
  teamEdits: TeamEdits;
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
