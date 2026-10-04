import nodemailer from "nodemailer";

/** Outgoing email (SMTP_*, MAIL_FROM). */
export interface SmtpSettings {
  host: string;
  port: number;
  /** TLS from the start (port 465); otherwise STARTTLS when the server offers it */
  secure: boolean;
  user: string | null;
  password: string | null;
  /** e.g. "GanttLines <plan@example.com>" */
  from: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Sends through the configured SMTP server. */
export function smtpMailer(settings: SmtpSettings): Mailer {
  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    ...(settings.user ? { auth: { user: settings.user, pass: settings.password ?? "" } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    async send({ to, subject, text }) {
      await transport.sendMail({ from: settings.from, to, subject, text });
    },
  };
}

/** SMTP_HOST (+ SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_SECURE) and MAIL_FROM; off without SMTP_HOST. */
export function smtpSettings(env: NodeJS.ProcessEnv): SmtpSettings | null {
  const host = env["SMTP_HOST"];
  if (!host) return null;
  const port = Number(env["SMTP_PORT"] || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid SMTP_PORT: ${env["SMTP_PORT"]}`);
  const from = env["MAIL_FROM"];
  if (!from) throw new Error("MAIL_FROM is required with SMTP_HOST (e.g. GanttLines <plan@example.com>)");
  return {
    host,
    port,
    secure: env["SMTP_SECURE"] ? env["SMTP_SECURE"] === "true" : port === 465,
    user: env["SMTP_USER"] || null,
    password: env["SMTP_PASSWORD"] || null,
    from,
  };
}
