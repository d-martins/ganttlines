import type { Db } from "@ganttlines/db";
import type { FastifyReply } from "fastify";
import type { LoginLimiter } from "../auth/login-limiter";
import { SESSION_COOKIE, type SessionStore } from "../auth/sessions";
import type { InstanceService } from "../calendar/instance-service";
import type { Config } from "../config";

/** Shared dependencies handed to every route module. */
export interface RouteContext {
  db: Db;
  config: Config;
  sessions: SessionStore;
  loginLimiter: LoginLimiter;
  instance: InstanceService;
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
