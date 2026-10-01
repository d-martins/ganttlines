import { expect, test } from "@playwright/test";
import { ADMIN, linkIn, mailTo, resetDatabase, setupAdmin } from "../support";

test.beforeEach(async () => {
  await resetDatabase();
});

test("an invitation email lets a new person choose their password and walk straight in", async ({ page, browser }) => {
  await setupAdmin(page.request);
  await page.goto("/settings");
  await page.getByLabel("Name", { exact: true }).fill("Eve Editor");
  await page.getByLabel("Email", { exact: true }).fill("eve@example.test");
  await page.getByRole("button", { name: "Add user" }).click();
  await expect(page.getByText("Invitation sent to eve@example.test")).toBeVisible();

  const invitation = await mailTo("eve@example.test");
  expect(invitation).toContain(`${ADMIN.name} added you to GanttLines`);
  const eve = await (await browser.newContext()).newPage();
  await eve.goto(linkIn(invitation));
  await eve.getByLabel("New password (8+ characters)").fill("eve's own password");
  await eve.getByRole("button", { name: "Save and sign in" }).click();
  await expect(eve.getByRole("button", { name: "Account menu" })).toBeVisible();
});

test("a forgotten password is reset through an emailed link", async ({ page, browser }) => {
  await setupAdmin(page.request);
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto("/login");
  await visitor.getByRole("link", { name: "Forgot your password?" }).click();
  await visitor.getByLabel("Email").fill(ADMIN.email);
  await visitor.getByRole("button", { name: "Email me a link" }).click();
  await expect(visitor.getByRole("status")).toContainText("a link is on its way");

  await visitor.goto(linkIn(await mailTo(ADMIN.email)));
  await visitor.getByLabel("New password (8+ characters)").fill("a brand-new password");
  await visitor.getByRole("button", { name: "Save and sign in" }).click();
  await expect(visitor.getByRole("button", { name: "Account menu" })).toBeVisible();
  // The old password no longer works.
  expect((await visitor.request.post("/api/auth/login", { data: { email: ADMIN.email, password: ADMIN.password } })).status()).toBe(401);
});
