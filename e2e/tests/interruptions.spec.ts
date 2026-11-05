import { expect, test, type Page } from "@playwright/test";
import { addTask, command, createProject, listRow, resetDatabase, setupAdmin } from "../support";

const DAY = 32;
const barOf = (page: Page, title: string) => page.getByRole("button", { name: new RegExp(`^${title}, `) });
const parts = (page: Page) => page.getByTestId("bar-part");
/** The screen x a quarter into the day `days` after the bar starts. */
const dayX = async (page: Page, title: string, days: number) => {
  const box = (await barOf(page, title).boundingBox())!;
  return box.x + days * DAY + DAY / 4;
};

/** Scrolls the chart so `title`'s bar is clear of the task list. */
const bringIntoView = async (page: Page, title: string) => {
  await expect(barOf(page, title)).toBeAttached();
  const box = (await barOf(page, title).boundingBox())!;
  await page.getByTestId("board-scroller").evaluate((scroller, by) => {
    scroller.scrollLeft += by;
  }, box.x - 850);
};

test.beforeEach(async ({ page }) => {
  await resetDatabase();
  await setupAdmin(page.request);
});

test("cut a task and its follower moves; Undo puts both back", async ({ page }) => {
  const projectId = await createProject(page.request, "Launch");
  const build = await addTask(page.request, projectId, "Build", "2026-10-12", 2);
  const ship = await addTask(page.request, projectId, "Ship", "2026-10-14", 1);
  await command(page.request, projectId, { type: "addLink", predecessorId: build, followerId: ship, kind: "FS" });
  await page.goto(`/p/${projectId}`);
  await expect(listRow(page, "Build")).toBeVisible();
  await bringIntoView(page, "Build");
  const shipAt = async () => (await barOf(page, "Ship").boundingBox())!.x - (await barOf(page, "Build").boundingBox())!.x;
  const before = await shipAt();
  await barOf(page, "Build").hover();
  await page.getByRole("button", { name: "Interrupt “Build”" }).click();
  const y = (await barOf(page, "Build").boundingBox())!.y + 5;
  await page.mouse.move(await dayX(page, "Build", 1), y);
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.move(await dayX(page, "Build", 4), y);
  await page.mouse.down();
  await page.mouse.up();
  await expect(parts(page)).toHaveCount(2);
  await expect(page.getByTestId("bar-gap")).toHaveCount(1);
  await expect.poll(shipAt).toBeGreaterThan(before);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(parts(page)).toHaveCount(0);
  await expect.poll(shipAt).toBe(before);
});

test("A interrupts B from the menu, and moving A moves the gap", async ({ page }) => {
  const projectId = await createProject(page.request, "Launch");
  await addTask(page.request, projectId, "Hotfix", "2026-10-13", 3);
  await addTask(page.request, projectId, "Build", "2026-10-12", 2);
  await page.goto(`/p/${projectId}`);
  await expect(listRow(page, "Build")).toBeVisible();
  await bringIntoView(page, "Build");
  await barOf(page, "Hotfix").hover();
  const handle = barOf(page, "Hotfix").locator("..").getByTitle("Drag onto another task to link them");
  const from = (await handle.boundingBox())!;
  const to = (await barOf(page, "Build").boundingBox())!;
  await page.mouse.move(from.x + 3, from.y + 3);
  await page.mouse.down();
  await page.mouse.move(to.x + 10, to.y + 5, { steps: 4 });
  await page.mouse.up();
  const menu = page.getByRole("menu", { name: "Link Hotfix and Build" });
  await expect(menu).toBeVisible();
  // Pointing shows it on the board, and sends nothing.
  await menu.getByRole("menuitem", { name: /Hotfix interrupts Build/ }).hover();
  await expect(parts(page)).toHaveCount(2);
  await menu.getByRole("menuitem", { name: /Hotfix interrupts Build/ }).click();
  await expect(menu).toBeHidden();
  await expect(parts(page)).toHaveCount(2);
  // Off the board's way, the gap closes; the relation stays.
  await page.getByRole("button", { name: "Open details of “Hotfix”" }).click();
  const panel = page.getByRole("complementary", { name: "Details of “Hotfix”" });
  await panel.getByLabel("Start", { exact: true }).fill("2026-11-02");
  await panel.getByLabel("Start", { exact: true }).press("Enter");
  await expect(parts(page)).toHaveCount(0);
  await expect(panel.getByRole("combobox", { name: /^Interrupts .*: this task$/ })).toHaveValue("interrupts");
});

test("the menu stays on screen when dropped low in the window", async ({ page }) => {
  const projectId = await createProject(page.request, "Launch");
  // New tasks go on top, so Build ends up on the lowest row.
  await addTask(page.request, projectId, "Build", "2026-10-12", 2);
  for (const title of ["One", "Two", "Three", "Four", "Five"]) await addTask(page.request, projectId, title, "2026-10-12", 1);
  await addTask(page.request, projectId, "Hotfix", "2026-10-13", 3);
  await page.setViewportSize({ width: 1440, height: 400 });
  await page.goto(`/p/${projectId}`);
  await expect(listRow(page, "Build")).toBeVisible();
  await bringIntoView(page, "Build");
  await barOf(page, "Hotfix").hover();
  const from = (await barOf(page, "Hotfix").locator("..").getByTitle("Drag onto another task to link them").boundingBox())!;
  const to = (await barOf(page, "Build").boundingBox())!;
  await page.mouse.move(from.x + 3, from.y + 3);
  await page.mouse.down();
  await page.mouse.move(to.x + 10, to.y + 5, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole("menuitem", { name: /Hotfix interrupts Build/ })).toBeInViewport({ ratio: 1 });
});

test("an interruption from the panel", async ({ page }) => {
  const projectId = await createProject(page.request, "Launch");
  await addTask(page.request, projectId, "Build", "2026-10-12", 2);
  await page.goto(`/p/${projectId}`);
  await page.getByRole("button", { name: "Open details of “Build”" }).click();
  const panel = page.getByRole("complementary", { name: "Details of “Build”" });
  await panel.getByRole("button", { name: "Add interruption" }).click();
  await panel.getByLabel("Interrupted from").fill("2026-10-13");
  await panel.getByLabel("Interrupted until").fill("2026-10-15");
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(panel.getByText(/^Still 2 days of work\. Now finishes/)).toBeVisible();
  await expect(parts(page)).toHaveCount(2);
  await panel.getByRole("button", { name: /^Remove interruption/ }).click();
  await expect(parts(page)).toHaveCount(0);
});
