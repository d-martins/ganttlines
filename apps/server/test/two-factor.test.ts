import type { FastifyInstance } from "fastify";
import * as OTPAuth from "otpauth";
import { describe, expect, it } from "vitest";
import type { MailMessage } from "../src/mail/mailer";
import { ADMIN, createUser, sessionCookie, setupAdmin, testApp, testConfig, useTestApp } from "./helpers";

const t = useTestApp();

/** What an authenticator app shows for `secret` at `time`. */
const codeFor = (secret: string, time: Date) =>
  new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30, algorithm: "SHA1" }).generate({ timestamp: time.getTime() });

/** Turns two-factor on for the signed-in `cookie`; returns the secret and recovery codes. */
async function enable(app: FastifyInstance, cookie: string, now: Date) {
  const setup = await app.inject({ method: "POST", url: "/api/auth/2fa/setup", headers: { cookie } });
  const { secret, otpauthUrl, qrSvg } = setup.json<{ secret: string; otpauthUrl: string; qrSvg: string }>();
  expect(otpauthUrl).toMatch(/^otpauth:\/\/totp\/GanttLines:.*secret=/);
  expect(qrSvg).toContain("<svg");
  const enabled = await app.inject({ method: "POST", url: "/api/auth/2fa/enable", headers: { cookie }, payload: { code: codeFor(secret, now) } });
  return { secret, recoveryCodes: enabled.json<{ recoveryCodes: string[] }>().recoveryCodes };
}

const passwordStep = (app: FastifyInstance, email = ADMIN.email, password = ADMIN.password) =>
  app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
const codeStep = (app: FastifyInstance, challenge: string, code: string) => app.inject({ method: "POST", url: "/api/auth/login/2fa", payload: { challenge, code } });

describe("two-factor sign-in", () => {
  it("asks for a code from the app after the password, and only then signs in", async () => {
    await setupAdmin(t.app);
    const cookie = sessionCookie(await passwordStep(t.app));
    const { secret, recoveryCodes } = await enable(t.app, cookie, t.clock.now);
    expect(recoveryCodes).toHaveLength(10);
    expect((await t.app.inject({ url: "/api/auth/me", headers: { cookie } })).json().user.twoFactor).toBe(true);

    const first = await passwordStep(t.app);
    expect(first.cookies.find((c) => c.name === "gp_session")).toBeUndefined();
    const { challenge } = first.json<{ twoFactor: { challenge: string } }>().twoFactor;
    expect((await codeStep(t.app, challenge, "000000")).json()).toMatchObject({ error: "wrong_code" });

    t.clock.now = new Date(t.clock.now.getTime() + 60_000); // a later code than the one used to turn it on
    const second = await codeStep(t.app, challenge, codeFor(secret, t.clock.now));
    expect(second.statusCode).toBe(200);
    expect((await t.app.inject({ url: "/api/auth/me", headers: { cookie: sessionCookie(second) } })).statusCode).toBe(200);
    // The same code can't be used twice.
    const replay = await codeStep(t.app, (await passwordStep(t.app)).json().twoFactor.challenge, codeFor(secret, t.clock.now));
    expect(replay.statusCode).toBe(401);
  });

  it("takes each recovery code once, however it's typed", async () => {
    await setupAdmin(t.app);
    const { recoveryCodes } = await enable(t.app, sessionCookie(await passwordStep(t.app)), t.clock.now);
    const typed = ` ${recoveryCodes[0]!.toUpperCase().replace("-", " ")} `;
    expect((await codeStep(t.app, (await passwordStep(t.app)).json().twoFactor.challenge, typed)).statusCode).toBe(200);
    expect((await codeStep(t.app, (await passwordStep(t.app)).json().twoFactor.challenge, recoveryCodes[0]!)).statusCode).toBe(401);
  });

  it("expires the password step's proof after 5 minutes, and ignores forged ones", async () => {
    await setupAdmin(t.app);
    const { secret } = await enable(t.app, sessionCookie(await passwordStep(t.app)), t.clock.now);
    const { challenge } = (await passwordStep(t.app)).json().twoFactor;
    t.clock.now = new Date(t.clock.now.getTime() + 6 * 60_000);
    expect((await codeStep(t.app, challenge, codeFor(secret, t.clock.now))).json()).toMatchObject({ error: "challenge_expired" });
    expect((await codeStep(t.app, `${challenge.split(".")[0]}.forged-signature`, codeFor(secret, t.clock.now))).json()).toMatchObject({ error: "challenge_expired" });
  });

  it("only turns on with a right code, and turns off with your password", async () => {
    await setupAdmin(t.app);
    const cookie = sessionCookie(await passwordStep(t.app));
    await t.app.inject({ method: "POST", url: "/api/auth/2fa/setup", headers: { cookie } });
    expect((await t.app.inject({ method: "POST", url: "/api/auth/2fa/enable", headers: { cookie }, payload: { code: "123456" } })).statusCode).toBe(400);
    expect((await t.app.inject({ url: "/api/auth/me", headers: { cookie } })).json().user.twoFactor).toBe(false);
    expect((await passwordStep(t.app)).json().user).toBeDefined(); // still one step

    await enable(t.app, cookie, t.clock.now);
    const wrong = await t.app.inject({ method: "POST", url: "/api/auth/2fa/disable", headers: { cookie }, payload: { password: "nope" } });
    expect(wrong.statusCode).toBe(401);
    const off = await t.app.inject({ method: "POST", url: "/api/auth/2fa/disable", headers: { cookie }, payload: { password: ADMIN.password } });
    expect(off.json().user.twoFactor).toBe(false);
    expect((await passwordStep(t.app)).json().user).toBeDefined();
  });

  it("lets an admin turn it off for someone who lost their phone", async () => {
    const admin = await setupAdmin(t.app);
    const eve = await createUser(t.app, admin, { email: "eve@example.com", name: "Eve", role: "editor" });
    await enable(t.app, eve.cookie, t.clock.now);
    expect((await t.app.inject({ method: "POST", url: `/api/users/${eve.id}/disable-2fa`, headers: { cookie: eve.cookie } })).statusCode).toBe(403);
    const reset = await t.app.inject({ method: "POST", url: `/api/users/${eve.id}/disable-2fa`, headers: { cookie: admin } });
    expect(reset.json().user.twoFactor).toBe(false);
    expect((await passwordStep(t.app, "eve@example.com", eve.password)).json().user).toBeDefined();
  });

  it("still asks for the code after a password reset by email", async () => {
    const sent: MailMessage[] = [];
    const app = await testApp({ db: t.db, config: testConfig, mailer: { send: async (message) => void sent.push(message) }, now: () => t.clock.now });
    const cookie = await setupAdmin(app);
    await enable(app, cookie, t.clock.now);
    await app.inject({ method: "POST", url: "/api/auth/forgot", payload: { email: ADMIN.email } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const token = /token=([\w-]+)/.exec(sent[0]!.text)![1];
    const reset = await app.inject({ method: "POST", url: "/api/auth/reset", payload: { token, password: "a fresh password" } });
    expect(reset.json()).toEqual({ twoFactor: { challenge: expect.any(String) } });
    expect(reset.cookies.find((c) => c.name === "gp_session")).toBeUndefined();
    await app.close();
  });
});
