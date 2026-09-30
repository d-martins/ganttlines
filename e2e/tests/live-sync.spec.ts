import { expect, test } from "@playwright/test";
import { addTask, command, createProject, listRow, resetDatabase, setupAdmin, signedInUser } from "../support";

test("two people see each other's edits live, including cascades and undo", async ({ page, browser }) => {
  await resetDatabase();
  await setupAdmin(page.request);
  const projectId = await createProject(page.request, "Launch");
  const build = await addTask(page.request, projectId, "Build", "2026-10-05", 1);
  const design = await addTask(page.request, projectId, "Design", "2026-10-05", 2); // Mon 5 – Tue 6
  await command(page.request, projectId, { type: "linkTasks", fromId: design, toId: build });
  const eve = await signedInUser(browser, page.request, { email: "eve@example.test", name: "Eve Editor", role: "editor" });

  await page.goto(`/p/${projectId}`);
  await eve.page.goto(`/p/${projectId}`);
  const buildBar = (on: typeof page, day: string) => on.getByRole("button", { name: new RegExp(`^Build, ${day}$`) });
  await expect(buildBar(eve.page, "Oct 7")).toBeVisible(); // follows Design: Wed 7

  // Ada makes Design longer: Build moves for Eve too.
  await page.getByRole("button", { name: "Working days of “Design”" }).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("4");
  await page.keyboard.press("Enter");
  await expect(eve.page.getByRole("button", { name: "Working days of “Design”" })).toHaveText("4");
  await expect(buildBar(eve.page, "Oct 9")).toBeVisible(); // after Mon 5 – Thu 8

  // Ada undoes it: both are back where they were.
  await page.getByRole("button", { name: /^Undo/ }).click();
  await expect(buildBar(eve.page, "Oct 7")).toBeVisible();
  await expect(buildBar(page, "Oct 7")).toBeVisible();

  // Eve adds a task; Ada sees it appear.
  await eve.page.getByRole("button", { name: "Add task" }).click();
  await eve.page.getByRole("textbox", { name: "Title" }).fill("Test plan");
  await eve.page.keyboard.press("Enter");
  await expect(listRow(page, "Test plan")).toBeVisible();

  await eve.context.close();
});
