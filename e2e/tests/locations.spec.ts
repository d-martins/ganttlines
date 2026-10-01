import { expect, test } from "@playwright/test";
import { addTask, command, createProject, resetDatabase, setupAdmin } from "../support";

test("a location's public holidays move the tasks of the people in it", async ({ page }) => {
  await resetDatabase();
  await setupAdmin(page.request);
  const ana = (await (await page.request.post("/api/resources", { data: { name: "Ana" } })).json()).resource;
  const projectId = await createProject(page.request, "Launch");
  // Thu 24 Dec – Mon 28 Dec 2026: 3 working days (Thu, Fri, Mon) — until Christmas is a day off for her.
  const task = await addTask(page.request, projectId, "Wrap-up", "2026-12-24", 3);
  await command(page.request, projectId, { type: "setAssignee", id: task, resourceId: ana.id });

  await page.goto("/team");
  await page.getByLabel("New location").fill("Lisbon office");
  await page.getByRole("button", { name: "Add location" }).click();
  await page.getByLabel("Country of Lisbon office").selectOption({ label: "Portugal" });
  await page.getByLabel("Location of Ana").selectOption({ label: "Lisbon office" });
  await page.getByRole("button", { name: "Public holidays…" }).click();
  await page.getByLabel("Year").selectOption("2026");
  const list = page.getByRole("list", { name: "Public holidays for Lisbon office" });
  await expect(list.getByRole("checkbox", { name: /Christmas Day/ })).toBeChecked(); // days off by law come ticked
  await page.getByRole("button", { name: /^Add \d+ holidays$/ }).click();
  await expect(page.getByText("Christmas Day")).toBeVisible(); // now in the holiday list, for the location
  await expect(page.getByRole("listitem").filter({ hasText: /^Christmas Day/ })).toContainText("Lisbon office");

  // On the board, Ana's task now skips Friday 25: Thu 24, Mon 28, Tue 29.
  await page.goto(`/p/${projectId}`);
  await expect(page.getByRole("button", { name: /^Wrap-up, Dec 24 – Dec 29, Ana$/ })).toBeVisible();
});
