import { RequireTwoFactorBody, UpdateCheckBody, type AboutDto } from "@ganttlines/protocol";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth/guard";
import { conflict, HttpError } from "../errors";
import { testEmail } from "../mail/messages";
import { isNewer, type UpdateChecker } from "../updates";
import { parseBody } from "../validation";
import type { RouteContext } from "./context";

/** The running version for everyone signed in; admins also see (and switch) the update check. */
export function aboutRoutes(app: FastifyInstance, { db, config, mailer, twoFactorPolicy }: RouteContext, updates: UpdateChecker): void {
  app.get("/api/about", async (request): Promise<AboutDto> => {
    const user = requireUser(request);
    if (user.role !== "admin") return { version: config.version };
    const settings = await db.settings.findUnique({ where: { id: 1 } });
    const enabled = settings?.updateCheck ?? true;
    const latest = enabled ? await updates.latest() : null;
    return {
      version: config.version,
      updates: { enabled, latest, available: latest !== null && isNewer(latest.version, config.version) },
      mail: { configured: mailer !== null },
      requireTwoFactor: await twoFactorPolicy.requirement(),
    };
  });

  /** Sends the admin a test email, to check the SMTP settings; the server's error comes back as is. */
  app.post("/api/settings/test-email", async (request) => {
    const admin = requireUser(request, "admin");
    if (!mailer) throw new HttpError(409, "mail_not_configured", "Email isn't set up — add the SMTP_* settings and restart");
    try {
      await mailer.send(testEmail(admin.email, admin.name, config.publicUrl.origin));
    } catch (error) {
      throw new HttpError(502, "mail_failed", `Sending failed: ${(error as Error).message}`);
    }
    return { sentTo: admin.email };
  });

  app.put("/api/settings/update-check", async (request) => {
    requireUser(request, "admin");
    const { enabled } = parseBody(UpdateCheckBody, request.body);
    await db.settings.upsert({ where: { id: 1 }, create: { id: 1, updateCheck: enabled }, update: { updateCheck: enabled } });
    return { enabled };
  });

  /**
   * Who must use two-factor. The admin making the change must already use it when it would cover
   * them, so nobody locks themselves into the setup screen by surprise.
   */
  app.put("/api/settings/require-two-factor", async (request) => {
    const admin = requireUser(request, "admin");
    const { require } = parseBody(RequireTwoFactorBody, request.body);
    if (!admin.totpEnabled && twoFactorPolicy.covers(admin, require)) throw conflict("Turn on two-factor for your own account first");
    await twoFactorPolicy.set(require);
    return { require };
  });
}
