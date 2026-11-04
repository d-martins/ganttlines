import { expect, test } from "@playwright/test";
import { addTask, createProject, listRow, resetDatabase, setupAdmin, signedInUser } from "../support";

test("creates a milestone from Aiming for, sees a miss, turns on Critical path, and a shared link keeps the filter", async ({ page, browser }) => {
  await resetDatabase();
  await setupAdmin(page.request);
  const projectId = await createProject(page.request, "Launch");
  await addTask(page.request, projectId, "Build", "2026-10-12", 5);
  await addTask(page.request, projectId, "Docs", "2026-10-12", 1);

  await page.goto(`/p/${projectId}`);
  await expect(listRow(page, "Build")).toBeVisible();

  // Named on the spot: it starts on the task's finish, so nothing is late yet.
  await page.getByRole("button", { name: "Open details of “Build”" }).click();
  const panel = page.getByRole("complementary", { name: "Details of “Build”" });
  await panel.getByRole("combobox", { name: "Aiming for" }).click();
  await page.keyboard.type("Code freeze");
  await page.keyboard.press("Enter");
  const date = panel.getByLabel("Milestone date");
  await expect(date).toHaveValue("2026-10-16");
  await expect(panel.getByText("0 days to spare")).toBeVisible();
  await expect(page.getByTestId("milestone-line")).toHaveCount(1);

  // Moved earlier: the task now misses it, and says so.
  await date.fill("2026-10-14");
  await expect(panel.getByText(/2 days late/)).toBeVisible();
  await expect(page.locator('[data-slack="late"]')).toHaveCount(1);
  await panel.getByRole("button", { name: "Close details (Esc)" }).click();

  await page.getByRole("button", { name: "Critical path" }).click();
  await expect(listRow(page, "Build").getByRole("gridcell", { name: /^Can slip/ })).toContainText("\u22122 days · Code freeze");

  const filters = page.getByRole("toolbar", { name: "Filters" });
  await filters.getByRole("button", { name: "+ Filter" }).click();
  await page.getByRole("menuitem", { name: "Milestone" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Code freeze" }).click();
  await page.keyboard.press("Escape");
  await expect(listRow(page, "Docs")).toHaveCount(0);
  await expect(listRow(page, "Build")).toBeVisible();

  const shared = page.url();
  expect(shared).toContain("milestones");
  const eve = await signedInUser(browser, page.request, { email: "eve@example.test", name: "Eve Editor", role: "editor" });
  await eve.page.goto(shared);
  await expect(listRow(eve.page, "Build")).toBeVisible();
  await expect(listRow(eve.page, "Docs")).toHaveCount(0);
  // Eve hasn't turned the button on: the miss still shows, the column doesn't.
  await expect(eve.page.locator('[data-slack="late"]')).toHaveCount(1);
  await expect(eve.page.getByRole("columnheader", { name: "Can slip" })).toHaveCount(0);
});
