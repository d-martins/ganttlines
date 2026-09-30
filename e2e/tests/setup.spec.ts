import { expect, test } from "@playwright/test";
import { resetDatabase } from "../support";

test("a new install asks for the admin account, then the first project can be created", async ({ page }) => {
  await resetDatabase();
  await page.goto("/");
  await expect(page.getByText("Welcome to GanttLines")).toBeVisible();
  await page.getByLabel("Your name").fill("Ada Admin");
  await page.getByLabel("Email").fill("admin@example.test");
  await page.getByLabel("Password (8+ characters)").fill("admin-password-1");
  await page.getByRole("button", { name: "Create admin account" }).click();

  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("textbox", { name: "New project name" }).fill("Launch plan");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/p\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Launch plan" })).toBeVisible();

  // Still signed in, on the same board, after a reload (client-side route served by the server).
  await page.reload();
  await expect(page.getByRole("heading", { name: "Launch plan" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Launch plan" })).toBeVisible();
});
