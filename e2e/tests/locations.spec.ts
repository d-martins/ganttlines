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
  await page.getByLabel("Country of Lisbon office").click();
  await page.getByRole("combobox", { name: "Find a country" }).fill("portu");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Country of Lisbon office")).toHaveText("Portugal");
  await page.getByLabel("Location of Ana").selectOption({ label: "Lisbon office" });
  await page.getByRole("button", { name: "Public holidays…" }).click();
  await page.getByLabel("Year").selectOption("2026");
  const list = page.getByRole("list", { name: "Public holidays for Lisbon office" });
  await expect(list.getByRole("checkbox", { name: /Christmas Day/ })).toBeChecked(); // days off by law come ticked
  await page.getByRole("button", { name: /^Add \d+ holidays$/ }).click();
  const holidays = page.getByRole("list", { name: "Holidays", exact: true });
  await expect(holidays.getByRole("listitem").filter({ hasText: /^Christmas Day/ })).toContainText("Lisbon office"); // now in the holiday list, for the location
  // The list narrows to one person's days off (their location's included), or to a name.
  await page.getByLabel("Holidays for:").click();
  await page.getByRole("combobox", { name: "Find a location or person" }).fill("Ana");
  await page.keyboard.press("Enter");
  await expect(holidays.getByText("Christmas Day")).toBeVisible();
  await page.getByLabel("Find a holiday").fill("new year");
  await expect(holidays.getByRole("listitem")).toHaveCount(1);
  await expect(holidays).toContainText("New Year");

  // On the board, Ana's task now skips Friday 25: Thu 24, Mon 28, Tue 29.
  await page.goto(`/p/${projectId}`);
  await expect(page.getByRole("button", { name: /^Wrap-up, Dec 24 – Dec 29, Ana$/ })).toBeVisible();
});
