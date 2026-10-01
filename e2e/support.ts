import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import pg from "pg";

export const PORT = 3210;
export const BASE_URL = `http://localhost:${PORT}`;

export const ADMIN = { email: "admin@example.test", name: "Ada Admin", password: "admin-password-1" };

/** The setup code the server printed when it started (see global-setup.ts). */
export const setupCode = () => process.env["E2E_SETUP_CODE"] ?? "";

/** Empties every table, so each test starts from a brand-new install (first-run setup pending). */
export async function resetDatabase(): Promise<void> {
  const client = new pg.Client({ connectionString: process.env["E2E_DATABASE_URL"] });
  await client.connect();
  try {
    await client.query(
      `TRUNCATE "Comment", "Highlight", "Baseline", "ShareLink", "CommandLog", "TimeOff", "Holiday", "Settings", "Row", "Project", "Session", "Resource", "User" CASCADE`,
    );
  } finally {
    await client.end();
  }
}

async function ok<T>(response: Awaited<ReturnType<APIRequestContext["post"]>>): Promise<T> {
  expect(response.ok(), `${response.url()} → ${response.status()} ${await response.text()}`).toBe(true);
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T; // some replies (204) have no body
}

/** Completes first-run setup; the context (its pages too) is then signed in as the admin. */
export async function setupAdmin(request: APIRequestContext): Promise<void> {
  await ok(await request.post("/api/setup", { data: { ...ADMIN, setupCode: setupCode() } }));
}

/**
 * An account created by the admin, signed in in a new browser context (its temporary password
 * already replaced). Returns the context and a page on it.
 */
export async function signedInUser(
  browser: Browser,
  admin: APIRequestContext,
  user: { email: string; name: string; role: "admin" | "editor" | "viewer" | "guest" },
): Promise<{ context: BrowserContext; page: Page }> {
  const { temporaryPassword } = await ok<{ temporaryPassword: string }>(await admin.post("/api/users", { data: { ...user, createResource: user.role !== "guest" } }));
  const context = await browser.newContext();
  await ok(await context.request.post("/api/auth/login", { data: { email: user.email, password: temporaryPassword } }));
  await ok(await context.request.post("/api/auth/password", { data: { currentPassword: temporaryPassword, newPassword: `${user.role}-password-1` } }));
  return { context, page: await context.newPage() };
}

export async function createProject(request: APIRequestContext, name: string): Promise<string> {
  return (await ok<{ project: { id: string } }>(await request.post("/api/projects", { data: { name } }))).project.id;
}

/** Sends one board command (as the UI would); returns nothing but fails the test if it's refused. */
export async function command(request: APIRequestContext, projectId: string, body: Record<string, unknown>): Promise<void> {
  await ok(await request.post(`/api/projects/${projectId}/commands`, { data: { commandId: randomUUID(), command: body } }));
}

/** Adds a task as the first row of the project; returns its id. */
export async function addTask(request: APIRequestContext, projectId: string, title: string, start: string, duration: number): Promise<string> {
  const id = randomUUID();
  await command(request, projectId, { type: "createRow", id, kind: "task", parentId: null, afterId: null, title, start });
  await command(request, projectId, { type: "setDuration", id, duration });
  return id;
}

/** The list row showing `title`. */
export const listRow = (page: Page, title: string) => page.getByRole("row").filter({ has: page.getByText(title, { exact: true }) });
