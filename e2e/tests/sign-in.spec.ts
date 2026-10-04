import { expect, test } from "@playwright/test";
import { resetDatabase, setupAdmin } from "../support";

test("single sign-on: someone the admin added signs in through the provider; strangers are turned away", async ({ page, browser }) => {
  await resetDatabase();
  await setupAdmin(page.request);
  await page.request.post("/api/users", { data: { email: "eve@example.test", name: "Eve Editor", role: "editor", createResource: true } });

  const eve = await (await browser.newContext()).newPage();
  await eve.goto("/");
  await eve.getByRole("link", { name: "Sign in with Test IdP" }).click();
  await eve.getByLabel("Email").fill("eve@example.test"); // the provider's own sign-in form
  await eve.getByRole("button", { name: "Continue" }).click();
  await expect(eve.getByRole("button", { name: "Account menu" })).toBeVisible();
  expect((await (await eve.request.get("/api/auth/me")).json()).user).toMatchObject({ email: "eve@example.test", mustChangePassword: false });

  const stranger = await (await browser.newContext()).newPage();
  await stranger.goto("/login");
  await stranger.getByRole("link", { name: "Sign in with Test IdP" }).click();
  await stranger.getByLabel("Email").fill("mallory@example.test");
  await stranger.getByRole("button", { name: "Continue" }).click();
  await expect(stranger.getByRole("alert")).toHaveText(/no account for you here yet/);
});
