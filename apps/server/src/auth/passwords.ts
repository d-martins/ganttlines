import { hash, verify } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";

export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** 16 URL-safe characters; users must change it on first login. */
export function generateTemporaryPassword(): string {
  return randomBytes(12).toString("base64url");
}
