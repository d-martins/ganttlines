import { createDb, type Db } from "@ganttlines/db";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeEach, inject } from "vitest";
import { buildApp, type AppOptions } from "../src/app";
import type { Config } from "../src/config";

export const PUBLIC_URL = "http://localhost:3000";

export const testConfig: Config = {
  databaseUrl: "",
  sessionSecret: "test-secret-test-secret-test-secret-000",
  publicUrl: new URL(PUBLIC_URL),
  port: 3000,
  bind: "127.0.0.1",
  trustProxy: false,
  webDir: null,
  version: "1.2.0",
  initialAdmin: null,
  firstAdminEmail: null,
  cluster: "single",
  oidc: null,
  smtp: null,
};

/** The first-run setup code the test apps use. */
export const SETUP_CODE = "TESTS-SETUP";

/** An app for tests (fixed setup code); pass other options as for buildApp. */
export function testApp(options: Omit<AppOptions, "setupCode">): Promise<FastifyInstance> {
  return buildApp({ setupCode: SETUP_CODE, ...options });
}

export interface TestContext {
  db: Db;
  app: FastifyInstance;
  /** Mutable clock used by the app; advance it to test session expiry. */
  clock: { now: Date };
}

/** One app + DB client per test file; every table is emptied before each test. */
export function useTestApp(): TestContext {
  const context = {} as TestContext;
  const db = createDb(inject("databaseUrl"));
  context.db = db;
  context.clock = { now: new Date("2026-10-01T09:00:00Z") };

  beforeEach(async () => {
    await db.$executeRawUnsafe(
      `TRUNCATE "Comment", "Highlight", "Baseline", "ShareLink", "CommandLog", "TimeOff", "Holiday", "Settings", "Row", "Project", "Session", "Resource", "Location", "User" CASCADE`,
    );
    context.clock.now = new Date("2026-10-01T09:00:00Z");
    await context.app?.close();
    context.app = await testApp({ db, config: testConfig, now: () => context.clock.now });
  });

  afterAll(async () => {
    await context.app?.close();
    await db.$disconnect();
  });

  return context;
}

/** Extracts the session cookie ("gp_session=…") from a response, for use in later requests. */
export function sessionCookie(response: LightMyRequestResponse): string {
  const cookie = response.cookies.find((c) => c.name === "gp_session");
  if (!cookie) throw new Error(`No session cookie in response (${response.statusCode}: ${response.body})`);
  return `gp_session=${cookie.value}`;
}

export const ADMIN = { email: "admin@example.com", name: "Admin", password: "correct horse battery" };

/** Completes first-run setup and returns the admin's cookie. */
export async function setupAdmin(app: FastifyInstance): Promise<string> {
  return sessionCookie(await app.inject({ method: "POST", url: "/api/setup", payload: { ...ADMIN, setupCode: SETUP_CODE } }));
}

/** Creates a user as admin, then logs in as them and changes the temporary password. */
export async function createUser(
  app: FastifyInstance,
  adminCookie: string,
  user: { email: string; name: string; role: "admin" | "editor" | "viewer" | "guest" },
): Promise<{ id: string; cookie: string; password: string }> {
  const created = await app.inject({ method: "POST", url: "/api/users", headers: { cookie: adminCookie }, payload: user });
  const { user: dto, temporaryPassword } = created.json<{ user: { id: string }; temporaryPassword: string }>();
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: user.email, password: temporaryPassword } });
  const cookie = sessionCookie(login);
  const password = "a brand new password";
  await app.inject({
    method: "POST",
    url: "/api/auth/password",
    headers: { cookie },
    payload: { currentPassword: temporaryPassword, newPassword: password },
  });
  return { id: dto.id, cookie, password };
}
