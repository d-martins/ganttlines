import { expect, test } from "@playwright/test";
import { ADMIN, BASE_URL_2, createProject, listRow, LOCAL_URL, resetDatabase, setupAdmin } from "../support";

test("the local-only site: plan, reload, export, and open the file in another browser", async ({ browser }) => {
  const here = await browser.newContext({ baseURL: LOCAL_URL });
  const page = await here.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByLabel("New project name").fill("Garden");
  await page.keyboard.press("Enter");
  await page.getByRole("link", { name: "Garden" }).click();
  await page.getByRole("button", { name: "Add task" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("Dig");
  await page.keyboard.press("Enter");
  await expect(listRow(page, "Dig")).toBeVisible();
  await expect(page.getByRole("status", { name: "Saved in this browser" })).toBeVisible();
  await page.reload();
  await expect(listRow(page, "Dig")).toBeVisible();

  await page.getByRole("link", { name: "Settings" }).click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export" }).click()]);
  const file = await download.path();

  const elsewhere = await browser.newContext({ baseURL: LOCAL_URL });
  const there = await elsewhere.newPage();
  await there.goto("/settings");
  await there.getByLabel("Import a workspace file").setInputFiles(file);
  await there.getByRole("button", { name: "Replace" }).click();
  await there.getByRole("link", { name: "Garden" }).click();
  await expect(listRow(there, "Dig")).toBeVisible();
  await here.close();
  await elsewhere.close();
});

test("visitors plan in their browser; signing in shows the server's workspace, signing out brings theirs back", async ({ page, browser }) => {
  await resetDatabase();
  await setupAdmin(page.request);
  await createProject(page.request, "Server plan");
  const visitor = await browser.newContext({ baseURL: BASE_URL_2 });
  const tab = await visitor.newPage();
  await tab.goto("/");
  await tab.getByRole("button", { name: "New project" }).click();
  await tab.getByLabel("New project name").fill("Mine");
  await tab.keyboard.press("Enter");
  await expect(tab.getByRole("link", { name: "Mine" })).toBeVisible();

  await tab.getByRole("link", { name: "Sign in" }).click();
  await tab.getByLabel("Email").fill(ADMIN.email);
  await tab.getByLabel("Password").fill(ADMIN.password);
  await tab.getByRole("button", { name: "Sign in" }).click();
  await expect(tab.getByRole("link", { name: "Server plan" })).toBeVisible();
  await expect(tab.getByRole("link", { name: "Mine" })).toHaveCount(0);

  await tab.getByRole("button", { name: "Account menu" }).click();
  await tab.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(tab.getByRole("link", { name: "Mine" })).toBeVisible();
  await expect(tab.getByRole("link", { name: "Server plan" })).toHaveCount(0);
  await visitor.close();
});
