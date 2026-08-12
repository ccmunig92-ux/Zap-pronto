import { readFileSync } from "node:fs";

type Environment = Readonly<Record<string, string | undefined>>;

export interface ApiRuntimeConfig {
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly host: string;
  readonly port: number;
  readonly metaWebhook: MetaWebhookRuntimeConfig;
}

export type MetaWebhookRuntimeConfig = Readonly<{ enabled: false }> | Readonly<{
  enabled: true;
  appSecret: string;
  verifyToken: string;
  maxBodyBytes: number;
}>;

function integer(env: Environment, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`API_CONFIGURATION_INVALID:${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`API_CONFIGURATION_INVALID:${name}`);
  }
  return value;
}

function secret(env: Environment, directName: string, fileName: string): string {
  const direct = env[directName];
  const file = env[fileName]?.trim();
  if (direct !== undefined && file) throw new Error(`API_CONFIGURATION_SOURCE_CONFLICT:${directName}`);
  let value = direct;
  if (file) {
    try { value = readFileSync(file, "utf8"); }
    catch { throw new Error(`API_CONFIGURATION_FILE_UNREADABLE:${directName}`); }
  }
  if (value === undefined || value.length < 1 || Buffer.byteLength(value, "utf8") > 4096) {
    throw new Error(`API_CONFIGURATION_INVALID:${directName}`);
  }
  return value;
}

function metaWebhookConfig(env: Environment): MetaWebhookRuntimeConfig {
  const enabled = env.META_WEBHOOK_ENABLED ?? "false";
  if (enabled !== "true" && enabled !== "false") throw new Error("API_CONFIGURATION_INVALID:META_WEBHOOK_ENABLED");
  if (enabled === "false") return { enabled: false };
  return {
    enabled: true,
    appSecret: secret(env, "META_APP_SECRET", "META_APP_SECRET_FILE"),
    verifyToken: secret(env, "META_VERIFY_TOKEN", "META_VERIFY_TOKEN_FILE"),
    maxBodyBytes: integer(env, "META_WEBHOOK_MAX_BODY_BYTES", 1_048_576, 1, 1_048_576),
  };
}

export function loadApiRuntimeConfig(env: Environment = process.env): ApiRuntimeConfig {
  const directDatabaseUrl = env.DATABASE_URL?.trim();
  const databaseUrlFile = env.DATABASE_URL_FILE?.trim();
  if (directDatabaseUrl && databaseUrlFile) throw new Error("DATABASE_URL_SOURCE_CONFLICT");
  let databaseUrl = directDatabaseUrl;
  if (databaseUrlFile) {
    try {
      const value = readFileSync(databaseUrlFile,"utf8");
      if (value.length > 4096) throw new Error("too large");
      databaseUrl = value.trim();
    } catch { throw new Error("DATABASE_URL_FILE_UNREADABLE"); }
  }
  if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");
  let parsedDatabase: URL;
  try { parsedDatabase = new URL(databaseUrl); } catch { throw new Error("API_CONFIGURATION_INVALID:DATABASE_URL"); }
  if (!['postgres:', 'postgresql:'].includes(parsedDatabase.protocol) || !parsedDatabase.hostname) {
    throw new Error("API_CONFIGURATION_INVALID:DATABASE_URL");
  }
  const host = env.API_HOST?.trim() || "127.0.0.1";
  if (host.length > 253 || /[\s/]/.test(host)) throw new Error("API_CONFIGURATION_INVALID:API_HOST");
  return { databaseUrl, databasePoolMax: integer(env,"DATABASE_POOL_MAX",10,1,100),
    host, port: integer(env,"API_PORT",3000,1,65535), metaWebhook: metaWebhookConfig(env) };
}
