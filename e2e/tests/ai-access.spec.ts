import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, test } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { addTask, BASE_URL, createProject, listRow, resetDatabase, setupAdmin } from "../support";

const REDIRECT = "https://ai-app.example/callback";

async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const client = new Client({ name: "e2e", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

test("AI access: an admin turns it on, an app is approved in the browser, reads a board, and stops when disconnected", async ({ page }) => {
  await resetDatabase();
  await setupAdmin(page.request);
  const projectId = await createProject(page.request, "Launch");
  await addTask(page.request, projectId, "Design", "2026-10-05", 3);

  await page.goto("/settings");
  await page.getByLabel("Allow AI apps to connect").click();
  await expect(page.getByLabel("MCP server address")).toHaveText(`${BASE_URL}/mcp`);

  // The app discovers the server and registers itself.
  const unauthorized = await fetch(`${BASE_URL}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(unauthorized.status).toBe(401);
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(unauthorized.headers.get("www-authenticate") ?? "")![1]!;
  const issuer = ((await (await fetch(metadataUrl)).json()) as { authorization_servers: string[] }).authorization_servers[0];
  const server = (await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json()) as Record<string, string>;
  const registered = (await (await fetch(server["registration_endpoint"]!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Test AI", redirect_uris: [REDIRECT] }) })).json()) as { client_id: string };

  // The person approves in the browser; the browser goes back to the app with a code.
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: registered.client_id,
    redirect_uri: REDIRECT,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    scope: "plans:read team:read",
    state: "st",
    resource: `${BASE_URL}/mcp`,
  });
  let returned = "";
  await page.route(`${REDIRECT}**`, async (route) => {
    returned = route.request().url();
    await route.fulfill({ body: "back in the app" });
  });
  await page.goto(`${server["authorization_endpoint"]}?${query}`);
  await expect(page.getByRole("heading", { name: "Allow Test AI to use GanttLines?" })).toBeVisible();
  await page.getByRole("checkbox", { name: /Team calendar/ }).uncheck();
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByText("back in the app")).toBeVisible();
  const code = new URL(returned).searchParams.get("code")!;

  const tokens = (await (
    await fetch(server["token_endpoint"]!, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: registered.client_id, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${BASE_URL}/mcp` }),
    })
  ).json()) as { access_token: string; scope: string };
  expect(tokens.scope).toBe("plans:read");

  const board = await callTool(tokens.access_token, "get_project", { project: "Launch" });
  expect(board.structuredContent).toMatchObject({ rows: [{ title: "Design", start: "2026-10-05", end: "2026-10-07" }] });

  // Disconnecting it in Settings stops it at once.
  await page.goto("/settings");
  const mine = page.getByRole("list", { name: "Connected AI apps", exact: true });
  await expect(mine).toContainText("Test AI");
  await mine.getByRole("button", { name: "Disconnect" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText(/^None\. AI apps you connect/)).toBeVisible();
  await expect(callTool(tokens.access_token, "list_projects")).rejects.toThrow();
});

/** Registers an app, approves it in `page`'s browser (with the groups ticked as they come), and returns its access token. */
async function connectApp(page: import("@playwright/test").Page, scope: string): Promise<string> {
  const registered = (await (
    await fetch(`${BASE_URL}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }) })
  ).json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: registered.client_id,
    redirect_uri: REDIRECT,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    scope,
  });
  let returned = "";
  await page.route(`${REDIRECT}**`, async (route) => {
    returned = route.request().url();
    await route.fulfill({ body: "back in the app" });
  });
  await page.goto(`${BASE_URL}/oauth/authorize?${query}`);
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByText("back in the app")).toBeVisible();
  const tokens = (await (
    await fetch(`${BASE_URL}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: new URL(returned).searchParams.get("code")!, client_id: registered.client_id, redirect_uri: REDIRECT, code_verifier: verifier }),
    })
  ).json()) as { access_token: string };
  return tokens.access_token;
}

test("AI access: tasks an app adds show up live on an open board, credited to the person, and its undo takes them back", async ({ page, browser }) => {
  await resetDatabase();
  await setupAdmin(page.request);
  await page.request.put("/api/settings/mcp", { data: { enabled: true, scopes: ["plans:read", "plans:write"] } });
  const projectId = await createProject(page.request, "Launch");
  await addTask(page.request, projectId, "Design", "2026-10-05", 3);
  const token = await connectApp(await (await browser.newContext({ storageState: await page.context().storageState() })).newPage(), "plans:read plans:write");

  await page.goto(`/p/${projectId}`);
  await expect(listRow(page, "Design")).toBeVisible();
  const added = await callTool(token, "add_tasks", { project: "Launch", tasks: [{ title: "Build", predecessor: "Design", durationDays: 2 }, { title: "Ship", predecessor: "Build" }] });
  expect(added.isError).toBeFalsy();
  await expect(listRow(page, "Build")).toBeVisible();
  await expect(listRow(page, "Ship")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Build, Oct 8 – Oct 9/ })).toBeVisible(); // after Design (Mon 5 – Wed 7)

  // The task's history credits the person, via the app.
  await listRow(page, "Build").getByRole("button", { name: /Open details/ }).click();
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByText(/Ada Admin via Claude/).first()).toBeVisible();

  await callTool(token, "undo");
  await expect(listRow(page, "Build")).toHaveCount(0);
  await expect(listRow(page, "Ship")).toHaveCount(0);
  await expect(listRow(page, "Design")).toBeVisible();
});
