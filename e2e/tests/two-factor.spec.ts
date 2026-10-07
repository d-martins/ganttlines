import { expect, test } from "@playwright/test";
import * as OTPAuth from "otpauth";
import { ADMIN, resetDatabase, setupAdmin, signedInUser } from "../support";

/** What an authenticator app shows for this key right now (or for the next 30 s period). */
const code = (key: string, offset = 0) =>
  new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(key), digits: 6, period: 30, algorithm: "SHA1" }).generate({ timestamp: Date.now() + offset * 30_000 });

test("two-factor: turned on in Settings, then signing in asks for the app's code", async ({ page, browser }) => {
  await resetDatabase();
  await setupAdmin(page.request);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Turn on two-factor" }).waitFor();
  // Only the page's main area scrolls: nothing in the long settings page stretches the window too.
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.getByRole("group", { name: "Who must use two-factor" }).waitFor({ state: "attached" });
  expect(await page.evaluate<number>("document.documentElement.scrollHeight - window.innerHeight")).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Turn on two-factor" }).click();
  const key = (await page.getByLabel("Setup key").textContent())!.trim(); // as typed into an app
  await page.getByLabel("Code from the app").fill(code(key));
  await page.getByRole("button", { name: "Turn on", exact: true }).click();
  await expect(page.getByRole("list", { name: "Recovery codes" }).getByRole("listitem")).toHaveCount(10);

  const later = await (await browser.newContext()).newPage();
  await later.goto("/login");
  await later.getByLabel("Email").fill(ADMIN.email);
  await later.getByLabel("Password").fill(ADMIN.password);
  await later.getByRole("button", { name: "Sign in" }).click();
  await expect(later.getByRole("heading", { name: "Two-factor sign-in" })).toBeVisible();
  await later.getByLabel("Code").fill(code(key, 1)); // the next code (the current one was used to turn it on)
  await later.getByRole("button", { name: "Sign in" }).click();
  await expect(later.getByRole("button", { name: "Account menu" })).toBeVisible();
});

test("two-factor required for everyone: a teammate sets it up before getting in", async ({ page, browser }) => {
  await resetDatabase();
  await setupAdmin(page.request);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Turn on two-factor" }).click();
  const key = (await page.getByLabel("Setup key").textContent())!.trim();
  await page.getByLabel("Code from the app").fill(code(key));
  await page.getByRole("button", { name: "Turn on", exact: true }).click();
  await page.getByRole("button", { name: "I've saved them" }).click();
  await page.getByLabel("Required for everyone").click();
  await expect(page.getByLabel("Required for everyone")).toBeChecked();

  const { page: eve } = await signedInUser(browser, page.request, { email: "eve@example.test", name: "Eve", role: "editor" });
  await eve.goto("/team");
  await expect(eve.getByRole("heading", { name: "Set up two-factor sign-in" })).toBeVisible();
  await eve.getByRole("button", { name: "Turn on two-factor" }).click();
  const eveKey = (await eve.getByLabel("Setup key").textContent())!.trim();
  await eve.getByLabel("Code from the app").fill(code(eveKey));
  await eve.getByRole("button", { name: "Turn on", exact: true }).click();
  await eve.getByRole("button", { name: "I've saved them" }).click();
  await expect(eve.getByRole("button", { name: "Account menu" })).toBeVisible();
});
