import type { MailMessage } from "./mailer";

/** The emails GanttLines sends (plain text: readable everywhere, nothing to render or track). */

export function invitation(to: string, name: string, invitedBy: string, link: string): MailMessage {
  return {
    to,
    subject: `${invitedBy} invited you to GanttLines`,
    text: `Hi ${name},

${invitedBy} added you to GanttLines. Choose your password to sign in:

${link}

The link works once and expires in 7 days. If it has expired, ask ${invitedBy} to send a new one, or use "Forgot your password?" on the sign-in page.
`,
  };
}

export function passwordReset(to: string, name: string, link: string): MailMessage {
  return {
    to,
    subject: "Reset your GanttLines password",
    text: `Hi ${name},

Someone (hopefully you) asked to reset your GanttLines password. Choose a new one here:

${link}

The link works once and expires in 1 hour. If you didn't ask for this, ignore this email — your password stays as it is.
`,
  };
}

export function testEmail(to: string, name: string, publicUrl: string): MailMessage {
  return {
    to,
    subject: "GanttLines test email",
    text: `Hi ${name},

Email from GanttLines (${publicUrl}) works.
`,
  };
}
