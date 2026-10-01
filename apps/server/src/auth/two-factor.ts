import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";

const PERIOD = 30;
const CHALLENGE_FOR_MS = 5 * 60 * 1000;
const RECOVERY_CODES = 10;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** Recovery codes are typed by hand: ignore case, spaces and dashes. */
const normaliseRecovery = (code: string) => code.toLowerCase().replace(/[\s-]/g, "");

/**
 * Two-factor sign-in with an authenticator app (TOTP, RFC 6238: 6 digits, 30 s). Secrets are stored
 * encrypted with a key derived from SESSION_SECRET (changing that secret means re-enrolling).
 */
export class TwoFactor {
  private readonly key: Buffer;

  constructor(
    secret: string,
    private readonly now: () => number = Date.now,
  ) {
    this.key = createHash("sha256").update(`totp:${secret}`).digest();
  }

  /** A new random secret (base32) and how to add it to an app: QR code (SVG) and the otpauth:// link. */
  async enrolment(email: string): Promise<{ secret: string; otpauthUrl: string; qrSvg: string }> {
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    const otpauthUrl = this.totp(secret, email).toString();
    const qrSvg = await QRCode.toString(otpauthUrl, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return { secret, otpauthUrl, qrSvg };
  }

  /** The time step a code is valid for (one step of clock drift either way), or null. */
  check(secret: string, code: string): number | null {
    const token = code.replace(/\s/g, "");
    if (!/^\d{6}$/.test(token)) return null;
    const timestamp = this.now();
    const delta = this.totp(secret, "").validate({ token, timestamp, window: 1 });
    return delta === null ? null : Math.floor(timestamp / 1000 / PERIOD) + delta;
  }

  /** Ten single-use recovery codes ("k7m2-9qx4"), and the hashes to store. */
  recoveryCodes(): { codes: string[]; hashes: string[] } {
    const codes = Array.from({ length: RECOVERY_CODES }, () => {
      const raw = new OTPAuth.Secret({ size: 5 }).base32.toLowerCase();
      return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
    });
    return { codes, hashes: codes.map((code) => hash(normaliseRecovery(code))) };
  }

  /** The stored hash a recovery code matches, if any. */
  matchRecovery(hashes: readonly string[], code: string): string | undefined {
    const candidate = hash(normaliseRecovery(code));
    return hashes.find((stored) => stored === candidate);
  }

  encrypt(secret: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".");
  }

  decrypt(stored: string): string | null {
    try {
      const [iv, tag, data] = stored.split(".").map((part) => Buffer.from(part, "base64url"));
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv!);
      decipher.setAuthTag(tag!);
      return Buffer.concat([decipher.update(data!), decipher.final()]).toString("utf8");
    } catch {
      return null; // e.g. SESSION_SECRET changed
    }
  }

  /** Proof that the password step passed, for the second step (5 minutes). */
  challenge(userId: string): string {
    const body = Buffer.from(JSON.stringify({ u: userId, e: this.now() + CHALLENGE_FOR_MS })).toString("base64url");
    return `${body}.${this.mac(body)}`;
  }

  readChallenge(challenge: string): string | null {
    const [body, mac] = challenge.split(".");
    if (!body || !mac) return null;
    const [given, expected] = [Buffer.from(mac), Buffer.from(this.mac(body))];
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const { u, e } = JSON.parse(Buffer.from(body, "base64url").toString()) as { u: string; e: number };
      return e > this.now() ? u : null;
    } catch {
      return null;
    }
  }

  private totp(secret: string, label: string): OTPAuth.TOTP {
    return new OTPAuth.TOTP({ issuer: "GanttLines", label, algorithm: "SHA1", digits: 6, period: PERIOD, secret: OTPAuth.Secret.fromBase32(secret) });
  }

  private mac(body: string): string {
    return createHmac("sha256", this.key).update(`challenge:${body}`).digest("base64url");
  }
}
