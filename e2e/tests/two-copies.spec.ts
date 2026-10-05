import { expect, test } from "@playwright/test";
import { ADMIN, addTask, BASE_URL_2, createProject, listRow, resetDatabase, setupAdmin, signedInUser } from "../support";

test("two copies: people on different copies edit the same board live, and see each other", async ({ page, browser }) => {
  await resetDatabase();
  await setupAdmin(page.request);
  const projectId = await createProject(page.request, "Launch");
  await addTask(page.request, projectId, "Design", "2026-10-05", 2);
  const eve = await signedInUser(browser, page.request, { email: "eve@example.test", name: "Eve Editor", role: "editor" }, BASE_URL_2);

  await page.goto(`/p/${projectId}`);
  await eve.page.goto(`/p/${projectId}`); // Eve is on the other copy
  await expect(eve.page.getByRole("listitem", { name: ADMIN.name })).toBeVisible();
  await expect(page.getByRole("listitem", { name: "Eve Editor" })).toBeVisible();

  await page.getByRole("button", { name: "Add task" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("Build");
  await page.keyboard.press("Enter");
  await expect(listRow(eve.page, "Build")).toBeVisible();

  await eve.page.getByRole("button", { name: "Add task" }).click();
  await eve.page.getByRole("textbox", { name: "Title" }).fill("Ship");
  await eve.page.keyboard.press("Enter");
  await expect(listRow(page, "Ship")).toBeVisible();
  await eve.context.close();
});
