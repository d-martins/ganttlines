import { describe, expect, it } from "vitest";
import type { Mailer, MailMessage } from "../src/mail/mailer";
import { smtpSettings } from "../src/mail/mailer";
import { ADMIN, sessionCookie, setupAdmin, testApp, testConfig, useTestApp } from "./helpers";

const t = useTestApp();

/** Collects what would be sent; `failing` makes every send throw (an unreachable SMTP server). */
function outbox(failing = false): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    async send(message) {
      if (failing) throw new Error("connect ECONNREFUSED 127.0.0.1:25");
      sent.push(message);
    },
  };
}
const linkIn = (message: MailMessage) => /http:\/\/localhost:3000\/reset-password\?token=([\w-]+)/.exec(message.text)?.[1] ?? "";
const flush = () => new Promise((resolve) => setTimeout(resolve, 10)); // forgot-password sends in the background

describe("email", () => {
  it("invites new people to choose their own password (the admin never sees one)", async () => {
    const mail = outbox();
    const app = await testApp({ db: t.db, config: testConfig, mailer: mail });
    const admin = await setupAdmin(app);
    const created = await app.inject({ method: "POST", url: "/api/users", headers: { cookie: admin }, payload: { email: "eve@example.com", name: "Eve", role: "editor" } });
    expect(created.json()).toMatchObject({ invited: true, user: { email: "eve@example.com", mustChangePassword: true } });
    expect(created.json().temporaryPassword).toBeUndefined();
    expect(mail.sent).toEqual([expect.objectContaining({ to: "eve@example.com", subject: `${ADMIN.name} invited you to GanttLines` })]);

    const accepted = await app.inject({ method: "POST", url: "/api/auth/reset", payload: { token: linkIn(mail.sent[0]!), password: "eve's own password" } });
    expect(accepted.json().user).toMatchObject({ email: "eve@example.com", mustChangePassword: false });
    expect((await app.inject({ url: "/api/auth/me", headers: { cookie: sessionCookie(accepted) } })).statusCode).toBe(200);
    const again = await app.inject({ method: "POST", url: "/api/auth/reset", payload: { token: linkIn(mail.sent[0]!), password: "someone else's" } });
    expect(again.json()).toMatchObject({ error: "invalid_token" }); // works once
    await app.close();
  });

  it("falls back to a temporary password when the invitation can't be sent", async () => {
    const app = await testApp({ db: t.db, config: testConfig, mailer: outbox(true) });
    const admin = await setupAdmin(app);
    const created = await app.inject({ method: "POST", url: "/api/users", headers: { cookie: admin }, payload: { email: "eve@example.com", name: "Eve", role: "editor" } });
    expect(created.json()).toMatchObject({ inviteFailed: true, temporaryPassword: expect.any(String) });
    await app.close();
  });

  it("resets a forgotten password by email, answering the same for unknown addresses", async () => {
    const mail = outbox();
    const app = await testApp({ db: t.db, config: testConfig, mailer: mail });
    const admin = await setupAdmin(app);
    const unknown = await app.inject({ method: "POST", url: "/api/auth/forgot", payload: { email: "nobody@example.com" } });
    const known = await app.inject({ method: "POST", url: "/api/auth/forgot", payload: { email: ADMIN.email.toUpperCase() } });
    expect([unknown.statusCode, known.statusCode]).toEqual([204, 204]);
    await flush();
    expect(mail.sent.map((message) => message.to)).toEqual([ADMIN.email]);
    expect(mail.sent[0]!.subject).toBe("Reset your GanttLines password");

    const reset = await app.inject({ method: "POST", url: "/api/auth/reset", payload: { token: linkIn(mail.sent[0]!), password: "a fresh password" } });
    expect(reset.statusCode).toBe(200);
    expect((await app.inject({ url: "/api/auth/me", headers: { cookie: admin } })).statusCode).toBe(401); // other sessions end
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN.email, password: "a fresh password" } });
    expect(login.statusCode).toBe(200);
    await app.close();
  });

  it("expires reset links after an hour, and a newer link replaces the older one", async () => {
    const mail = outbox();
    const clock = { now: new Date("2026-10-01T09:00:00Z") };
    const app = await testApp({ db: t.db, config: testConfig, mailer: mail, now: () => clock.now });
    await setupAdmin(app);
    await app.inject({ method: "POST", url: "/api/auth/forgot", payload: { email: ADMIN.email } });
    await app.inject({ method: "POST", url: "/api/auth/forgot", payload: { email: ADMIN.email } });
    await flush();
    const [older, newer] = mail.sent.map(linkIn);
    expect((await app.inject({ method: "POST", url: "/api/auth/reset", payload: { token: older, password: "a fresh password" } })).statusCode).toBe(400);
    clock.now = new Date("2026-10-01T10:01:00Z");
    expect((await app.inject({ method: "POST", url: "/api/auth/reset", payload: { token: newer, password: "a fresh password" } })).statusCode).toBe(400);
    await app.close();
  });

  it("says when email isn't set up, and lets admins send themselves a test email", async () => {
    const off = await testApp({ db: t.db, config: testConfig, mailer: null });
    const admin = await setupAdmin(off);
    expect((await off.inject({ url: "/api/auth/providers" })).json()).toMatchObject({ passwordReset: false });
    expect((await off.inject({ method: "POST", url: "/api/auth/forgot", payload: { email: ADMIN.email } })).statusCode).toBe(503);
    expect((await off.inject({ method: "POST", url: "/api/settings/test-email", headers: { cookie: admin } })).statusCode).toBe(409);
    await off.close();

    const mail = outbox();
    const on = await testApp({ db: t.db, config: testConfig, mailer: mail });
    expect((await on.inject({ url: "/api/auth/providers" })).json()).toMatchObject({ passwordReset: true });
    const sent = await on.inject({ method: "POST", url: "/api/settings/test-email", headers: { cookie: admin } });
    expect(sent.json()).toEqual({ sentTo: ADMIN.email });
    expect(mail.sent[0]!.subject).toBe("GanttLines test email");
    await on.close();

    const broken = await testApp({ db: t.db, config: testConfig, mailer: outbox(true) });
    const failed = await broken.inject({ method: "POST", url: "/api/settings/test-email", headers: { cookie: admin } });
    expect(failed.json()).toMatchObject({ error: "mail_failed", message: expect.stringContaining("ECONNREFUSED") });
    await broken.close();
  });

  it("reads SMTP_* and MAIL_FROM, defaulting to port 587 (STARTTLS) and TLS on 465", () => {
    expect(smtpSettings({})).toBeNull();
    expect(smtpSettings({ SMTP_HOST: "smtp.example.com", MAIL_FROM: "GanttLines <plan@example.com>" })).toEqual({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: null,
      password: null,
      from: "GanttLines <plan@example.com>",
    });
    expect(smtpSettings({ SMTP_HOST: "h", SMTP_PORT: "465", SMTP_USER: "u", SMTP_PASSWORD: "p", MAIL_FROM: "x@y.z" })).toMatchObject({ port: 465, secure: true, user: "u" });
    expect(() => smtpSettings({ SMTP_HOST: "h" })).toThrow("MAIL_FROM is required");
  });
});
