import { expect, test } from "@playwright/test";
import * as OTPAuth from "otpauth";
import { ADMIN, resetDatabase, setupAdmin } from "../support";

/** What an authenticator app shows for this key right now (or for the next 30 s period). */
const code = (key: string, offset = 0) =>
  new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(key), digits: 6, period: 30, algorithm: "SHA1" }).generate({ timestamp: Date.now() + offset * 30_000 });

test("two-factor: turned on in Settings, then signing in asks for the app's code", async ({ page, browser }) => {
  await resetDatabase();
  await setupAdmin(page.request);
  await page.goto("/settings");
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
