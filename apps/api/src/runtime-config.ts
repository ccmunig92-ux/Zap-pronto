import { readFileSync } from "node:fs";

type Environment = Readonly<Record<string, string | undefined>>;

export interface ApiRuntimeConfig {
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly host: string;
  readonly port: number;
}

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
    host, port: integer(env,"API_PORT",3000,1,65535) };
}
