export interface Config {
  databaseUrl: string;
  /** HMAC key for session tokens; at least 32 characters */
  sessionSecret: string;
  /** Public base URL, e.g. http://localhost:3000 — used for cookie security and origin checks */
  publicUrl: URL;
  port: number;
  bind: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const databaseUrl = required(env, "DATABASE_URL");
  const sessionSecret = required(env, "SESSION_SECRET");
  if (sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  const publicUrl = new URL(env["PUBLIC_URL"] ?? "http://localhost:3000");
  const port = Number(env["PORT"] ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid PORT: ${env["PORT"]}`);
  return { databaseUrl, sessionSecret, publicUrl, port, bind: env["BIND"] ?? "127.0.0.1" };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
