import { expect, test } from "@playwright/test";
import { addTask, command, createProject, listRow, resetDatabase, setupAdmin, signedInUser } from "../support";

test("filters by a person and a tag, tags a task from the panel, and a shared link keeps its filters", async ({ page, browser }) => {
  await resetDatabase();
  await setupAdmin(page.request);
  const ana = (await (await page.request.post("/api/resources", { data: { name: "Ana" } })).json()).resource;
  const projectId = await createProject(page.request, "Launch");
  const docs = await addTask(page.request, projectId, "Docs", "2026-10-07", 1);
  const build = await addTask(page.request, projectId, "Build", "2026-10-06", 1);
  const design = await addTask(page.request, projectId, "Design", "2026-10-05", 1);
  await command(page.request, projectId, { type: "setAssignee", id: design, resourceId: ana.id });
  await command(page.request, projectId, { type: "setAssignee", id: build, resourceId: ana.id });
  await command(page.request, projectId, { type: "setTags", id: design, tags: ["UI"] });
  await command(page.request, projectId, { type: "setTags", id: build, tags: ["API"] });
  await command(page.request, projectId, { type: "setTags", id: docs, tags: ["UI"] });

  await page.goto(`/p/${projectId}`);
  await expect(listRow(page, "Docs")).toBeVisible();

  // From the bar: Ana's tasks tagged UI — only Design.
  const filters = page.getByRole("toolbar", { name: "Filters" });
  const pick = async (part: string, choice: string) => {
    await filters.getByRole("button", { name: "+ Filter" }).click();
    await page.getByRole("menuitem", { name: part }).click();
    await page.getByRole("menuitemcheckbox", { name: choice }).click();
    await page.keyboard.press("Escape");
  };
  await pick("People", "Ana");
  await expect(filters.getByText("2 of 3 tasks")).toBeVisible();
  await pick("Tags", "UI");
  await expect(filters.getByText("1 of 3 tasks")).toBeVisible();
  await expect(filters.getByRole("button", { name: "People: Ana", exact: true })).toBeVisible();
  await expect(filters.getByRole("button", { name: "Tag: UI", exact: true })).toBeVisible();
  await expect(listRow(page, "Design")).toBeVisible();
  await expect(listRow(page, "Build")).toHaveCount(0);
  await expect(listRow(page, "Docs")).toHaveCount(0);
  const shared = page.url();

  // A tag added in the panel shows beside the task's bar.
  await filters.getByRole("button", { name: "Clear all" }).click();
  await expect(listRow(page, "Docs")).toBeVisible();
  await page.getByRole("button", { name: "Open details of “Docs”" }).click();
  const panel = page.getByRole("complementary", { name: "Details of “Docs”" });
  await panel.getByRole("combobox", { name: "Add tag" }).fill("backend");
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("list", { name: "Tags" })).toContainText("backend");
  await panel.getByRole("button", { name: "Close details (Esc)" }).click();
  await expect(page.getByRole("button", { name: "Filter by the tag “backend”" })).toBeVisible(); // on the chart, beside Docs' bar

  // Someone else opens the shared link: the same filters, the same rows.
  const eve = await signedInUser(browser, page.request, { email: "eve@example.test", name: "Eve Editor", role: "editor" });
  await eve.page.goto(shared);
  const eveFilters = eve.page.getByRole("toolbar", { name: "Filters" });
  await expect(eveFilters.getByText("1 of 3 tasks")).toBeVisible();
  await expect(eveFilters.getByRole("button", { name: "People: Ana", exact: true })).toBeVisible();
  await expect(eveFilters.getByRole("button", { name: "Tag: UI", exact: true })).toBeVisible();
  await expect(listRow(eve.page, "Design")).toBeVisible();
  await expect(listRow(eve.page, "Build")).toHaveCount(0);
  await expect(listRow(eve.page, "Docs")).toHaveCount(0);
  await eve.context.close();
});
