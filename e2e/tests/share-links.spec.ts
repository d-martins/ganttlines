import { expect, test } from "@playwright/test";
import { addTask, createProject, listRow, resetDatabase, setupAdmin, signedInUser } from "../support";

test.beforeEach(async () => {
  await resetDatabase();
});

test("an anonymous edit link: pick a name, edit live, see nothing else, lose access when it's turned off", async ({ page, browser }) => {
  await setupAdmin(page.request);
  const projectId = await createProject(page.request, "Launch");
  await createProject(page.request, "Secret roadmap");
  await addTask(page.request, projectId, "Design", "2026-10-05", 2);
  const created = await page.request.post(`/api/projects/${projectId}/share-links`, { data: { access: "anonymous", collaboration: true } });
  const { url, link } = (await created.json()) as { url: string; link: { id: string } };
  await page.goto(`/p/${projectId}`);

  const visitor = await browser.newContext();
  const guestPage = await visitor.newPage();
  await guestPage.goto(url);
  await guestPage.getByLabel("Your name").fill("Val");
  await guestPage.getByRole("button", { name: "Open the board" }).click();
  await expect(guestPage.getByText("Editing via a shared link")).toBeVisible();
  await expect(guestPage.getByText("Val (anonymous)")).toBeVisible();

  await guestPage.getByRole("button", { name: "Title “Design”" }).click();
  await guestPage.getByRole("textbox", { name: "Title" }).fill("Design v2");
  await guestPage.keyboard.press("Enter");
  await expect(listRow(page, "Design v2")).toBeVisible(); // the admin sees it live

  // Only this board: no project list, no other projects.
  expect((await visitor.request.get("/api/projects")).ok()).toBe(false);
  await expect(guestPage.getByText("Secret roadmap")).toHaveCount(0);

  // Turned off: the open board says so at once.
  expect((await page.request.delete(`/api/share-links/${link.id}`)).ok()).toBe(true);
  await expect(guestPage.getByText(/turned off/)).toBeVisible();
  await visitor.close();
});

test("a sign-in link: asks strangers to sign in, and a guest account sees only that board, read-only", async ({ page, browser }) => {
  await setupAdmin(page.request);
  const projectId = await createProject(page.request, "Launch");
  await createProject(page.request, "Secret roadmap");
  await addTask(page.request, projectId, "Design", "2026-10-05", 2);
  const created = await page.request.post(`/api/projects/${projectId}/share-links`, { data: { access: "authenticated", collaboration: false } });
  const { url } = (await created.json()) as { url: string };

  const stranger = await browser.newContext();
  const strangerPage = await stranger.newPage();
  await strangerPage.goto(url);
  await expect(strangerPage.getByText("Sign in to open “Launch”")).toBeVisible();
  await stranger.close();

  const gus = await signedInUser(browser, page.request, { email: "gus@example.test", name: "Gus Guest", role: "guest" });
  await gus.page.goto(url);
  await expect(gus.page.getByText("Viewing via a shared link.")).toBeVisible();
  await expect(listRow(gus.page, "Design")).toBeVisible();
  await expect(gus.page.getByRole("button", { name: "Title “Design”" })).toHaveCount(0); // view only
  await expect(gus.page.getByText("Secret roadmap")).toHaveCount(0);
  await gus.context.close();
});
