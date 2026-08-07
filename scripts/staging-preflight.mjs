import { readFile, stat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const IMAGE = /^[^\s@]+(?:\/[^\s@]+)*@sha256:[a-f0-9]{64}$/;
const SECRET_NAMES = ["POSTGRES_PASSWORD_FILE", "DATABASE_MIGRATION_URL_FILE", "DATABASE_RUNTIME_URL_FILE"];
const SECRET_OWNERSHIP = Object.freeze({
  POSTGRES_PASSWORD_FILE: { uid: 70, gid: 70 },
  DATABASE_MIGRATION_URL_FILE: { uid: 1000, gid: 1000 },
  DATABASE_RUNTIME_URL_FILE: { uid: 1000, gid: 1000 },
});
const MINIMUMS = Object.freeze({
  postgres: { cpus: 1.5, memory: 1536 }, migrate: { cpus: 1, memory: 512 },
  "provision-runtime": { cpus: 0.5, memory: 256 }, api: { cpus: 1, memory: 768 }, web: { cpus: 0.5, memory: 256 },
});

function fail(code) { throw new Error(`STAGING_PREFLIGHT:${code}`); }
function required(env, name) { const value = env[name]?.trim(); if (!value) fail(`${name}_REQUIRED`); return value; }

export function parseEnv(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) fail("ENV_INVALID");
    const name = line.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || Object.hasOwn(env, name)) fail("ENV_INVALID");
    env[name] = line.slice(separator + 1).trim();
  }
  return env;
}

function httpsUrl(env, name, originOnly = false) {
  let url;
  try { url = new URL(required(env, name)); } catch { fail(`${name}_INVALID`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) fail(`${name}_INVALID`);
  if (originOnly && (url.pathname !== "/")) fail(`${name}_INVALID`);
  return url;
}

export function validateEnvironment(env) {
  for (const name of ["ZAP_API_IMAGE", "ZAP_WEB_IMAGE", "POSTGRES_IMAGE"]) {
    if (!IMAGE.test(required(env, name))) fail(`${name}_NOT_IMMUTABLE`);
  }
  const issuer = httpsUrl(env, "OIDC_ISSUER");
  const authority = httpsUrl(env, "OIDC_AUTHORITY_ORIGIN", true);
  const jwks = httpsUrl(env, "OIDC_JWKS_URL");
  if (issuer.origin !== authority.origin || issuer.origin !== jwks.origin) fail("OIDC_ORIGIN_MISMATCH");
  if (env.OIDC_DISCOVERY_URL?.trim()) {
    const discovery = httpsUrl(env, "OIDC_DISCOVERY_URL");
    if (discovery.origin !== issuer.origin) fail("OIDC_ORIGIN_MISMATCH");
  }
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(required(env, "OIDC_AUDIENCE"))) fail("OIDC_AUDIENCE_INVALID");
}

export async function validateSecrets(env, repoRoot) {
  if (typeof process.getuid !== "function") fail("POSIX_SECRET_METADATA_REQUIRED");
  const root = await realpath(repoRoot);
  const seen = new Set();
  for (const name of SECRET_NAMES) {
    const file = required(env, name);
    if (!isAbsolute(file)) fail(`${name}_NOT_ABSOLUTE`);
    let canonical, metadata;
    try { canonical = await realpath(file); metadata = await stat(canonical); } catch { fail(`${name}_UNREADABLE`); }
    validateSecretMetadata(name, canonical, metadata, root, seen, SECRET_OWNERSHIP[name]);
    seen.add(canonical);
  }
}

export function validateSecretMetadata(name, canonical, metadata, root, seen = new Set(), expectedOwner) {
  const relation = relative(root, canonical);
  if (!relation.startsWith("..") && !isAbsolute(relation)) fail(`${name}_INSIDE_REPOSITORY`);
  if (!metadata.isFile() || seen.has(canonical)) fail(`${name}_INVALID`);
  if ((metadata.mode & 0o777) !== 0o400) fail(`${name}_MODE_NOT_0400`);
  if (metadata.uid !== expectedOwner.uid || metadata.gid !== expectedOwner.gid) fail(`${name}_OWNER_MISMATCH`);
}

function memoryMiB(value) {
  const match = String(value ?? "").match(/^(\d+(?:\.\d+)?)([KMG])?$/i);
  if (!match) return NaN;
  return Number(match[1]) * ({ K: 1 / 1024, M: 1, G: 1024 }[match[2]?.toUpperCase() ?? "M"]);
}

export function validateResources(compose) {
  for (const [service, minimum] of Object.entries(MINIMUMS)) {
    const limits = compose.services?.[service]?.deploy?.resources?.limits;
    if (Number(limits?.cpus) < minimum.cpus || memoryMiB(limits?.memory) < minimum.memory) {
      fail(`${service.toUpperCase().replaceAll("-", "_")}_RESOURCES_BELOW_MINIMUM`);
    }
  }
}

export async function runPreflight(envFile, repoRoot = resolve(import.meta.dirname, "..")) {
  const env = parseEnv(await readFile(envFile, "utf8"));
  validateEnvironment(env);
  await validateSecrets(env, repoRoot);
  const rendered = spawnSync("docker", ["compose", "--env-file", envFile, "-f", resolve(repoRoot, "deploy/staging/compose.yaml"), "config", "--format", "json"], { encoding: "utf8" });
  if (rendered.status !== 0) fail("COMPOSE_INVALID");
  let compose; try { compose = JSON.parse(rendered.stdout); } catch { fail("COMPOSE_INVALID"); }
  validateResources(compose);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const envFile = process.argv[2];
  if (!envFile || !isAbsolute(envFile)) fail("ENV_FILE_ABSOLUTE_PATH_REQUIRED");
  await runPreflight(envFile);
  process.stdout.write("staging preflight passed\n");
}
