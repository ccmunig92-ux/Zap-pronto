import { readFile, stat, lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const IMAGE = /^[^\s@]+(?:\/[^\s@]+)*@sha256:[a-f0-9]{64}$/;
const SECRET_NAMES = ["POSTGRES_PASSWORD_FILE", "DATABASE_MIGRATION_URL_FILE", "DATABASE_RUNTIME_URL_FILE", "DATABASE_WORKER_URL_FILE", "META_APP_SECRET_FILE", "META_VERIFY_TOKEN_FILE"];
const SECRET_OWNERSHIP = Object.freeze({
  POSTGRES_PASSWORD_FILE: { uid: 70, gid: 70 },
  DATABASE_MIGRATION_URL_FILE: { uid: 1000, gid: 1000 },
  DATABASE_RUNTIME_URL_FILE: { uid: 1000, gid: 1000 },
  DATABASE_WORKER_URL_FILE: { uid: 1000, gid: 1000 },
  META_APP_SECRET_FILE: { uid: 1000, gid: 1000 },
  META_VERIFY_TOKEN_FILE: { uid: 1000, gid: 1000 },
});
const MINIMUMS = Object.freeze({
  postgres: { cpus: 1.5, memory: 1536 }, migrate: { cpus: 1, memory: 512 },
  "provision-runtime": { cpus: 0.5, memory: 256 }, api: { cpus: 1, memory: 768 },
  worker:{cpus:0.5,memory:384},web: { cpus: 0.5, memory: 256 },
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
  if (env.META_WHATSAPP_SECRET_ROOT?.trim()) {
    await validateMetaSecretRoot(env.META_WHATSAPP_SECRET_ROOT, root);
  }
  const seen = new Set();
  for (const name of SECRET_NAMES) {
    const file = required(env, name);
    if (!isAbsolute(file)) fail(`${name}_NOT_ABSOLUTE`);
    await assertNoSymlinkPath(name, file);
    let canonical, metadata;
    try { canonical = await realpath(file); metadata = await stat(canonical); } catch { fail(`${name}_UNREADABLE`); }
    validateSecretMetadata(name, canonical, metadata, root, seen, SECRET_OWNERSHIP[name]);
    seen.add(canonical);
  }
}

export async function validateMetaSecretRoot(configuredRoot, repositoryRoot) {
  if (!isAbsolute(configuredRoot)) fail("META_WHATSAPP_SECRET_ROOT_NOT_ABSOLUTE");
  await assertNoSymlinkPath("META_WHATSAPP_SECRET_ROOT", configuredRoot);
  let canonical;
  let metadata;
  try { canonical = await realpath(configuredRoot); metadata = await stat(canonical); } catch { fail("META_WHATSAPP_SECRET_ROOT_UNREADABLE"); }
  const relation = relative(repositoryRoot, canonical);
  if (!relation.startsWith("..") && !isAbsolute(relation)) fail("META_WHATSAPP_SECRET_ROOT_INSIDE_REPOSITORY");
  if (!metadata.isDirectory()) fail("META_WHATSAPP_SECRET_ROOT_NOT_DIRECTORY");
  if ((metadata.mode & 0o777) !== 0o750) fail("META_WHATSAPP_SECRET_ROOT_MODE_NOT_0750");
  if (metadata.uid !== 1000 || metadata.gid !== 1000) fail("META_WHATSAPP_SECRET_ROOT_OWNER_MISMATCH");
}

async function assertNoSymlinkPath(name, file) {
  const parents = [];
  let current = file;
  while (dirname(current) !== current) { parents.push(current); current = dirname(current); }
  for (const candidate of parents.reverse()) {
    let metadata; try { metadata = await lstat(candidate); } catch { fail(`${name}_UNREADABLE`); }
    if (metadata.isSymbolicLink()) fail(`${name}_SYMLINK_REJECTED`);
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

const EXPECTED_SECRETS = Object.freeze({
  postgres:["postgres_password"], migrate:["database_migration_url"],
  "provision-runtime":["database_migration_url","database_runtime_url","database_worker_url"],
  api:["database_runtime_url","meta_app_secret","meta_verify_token"],worker:["database_worker_url"],web:[],
});
const EXPECTED_DEPENDS = Object.freeze({
  postgres:{}, migrate:{postgres:"service_healthy"}, "provision-runtime":{migrate:"service_completed_successfully"},
  api:{"provision-runtime":"service_completed_successfully"},worker:{"provision-runtime":"service_completed_successfully"},web:{api:"service_healthy"},
});
const EXPECTED_NETWORKS = Object.freeze({ postgres:["data"], migrate:["data"], "provision-runtime":["data"],
  api:["app","data"],worker:["data"],web:["app"] });

export function validateComposeInvariants(compose) {
  if (compose.networks?.data?.internal !== true) fail("DATA_NETWORK_NOT_INTERNAL");
  for (const serviceName of Object.keys(MINIMUMS)) {
    const service = compose.services?.[serviceName];
    if (!service) fail(`${serviceName.toUpperCase().replaceAll("-","_")}_MISSING`);
    const ports = service.ports ?? [];
    if (serviceName === "web") {
      if (ports.length !== 1 || ports[0].host_ip !== "127.0.0.1" || Number(ports[0].target) !== 8080 || ports[0].protocol !== "tcp") fail("WEB_PORT_INVALID");
    } else if (ports.length) fail(`${serviceName.toUpperCase().replaceAll("-","_")}_PORTS_FORBIDDEN`);
    if (serviceName !== "postgres" && (service.read_only !== true || !service.cap_drop?.includes("ALL"))) fail(`${serviceName.toUpperCase().replaceAll("-","_")}_HARDENING_INVALID`);
    if (!service.security_opt?.includes("no-new-privileges:true")) fail(`${serviceName.toUpperCase().replaceAll("-","_")}_NO_NEW_PRIVILEGES_REQUIRED`);
    if (service.logging?.driver !== "json-file" || service.logging?.options?.["max-size"] !== "10m" || String(service.logging?.options?.["max-file"]) !== "5") fail(`${serviceName.toUpperCase().replaceAll("-","_")}_LOG_LIMIT_INVALID`);
    const secrets = (service.secrets ?? []).map((entry) => typeof entry === "string" ? entry : entry.source).sort();
    if (JSON.stringify(secrets) !== JSON.stringify([...EXPECTED_SECRETS[serviceName]].sort())) fail(`${serviceName.toUpperCase().replaceAll("-","_")}_SECRETS_INVALID`);
    const networks = Object.keys(service.networks ?? {}).sort();
    if (JSON.stringify(networks) !== JSON.stringify([...EXPECTED_NETWORKS[serviceName]].sort())) fail(`${serviceName.toUpperCase().replaceAll("-","_")}_NETWORKS_INVALID`);
    const depends = Object.fromEntries(Object.entries(service.depends_on ?? {}).map(([name,value]) => [name,value.condition]));
    if (JSON.stringify(depends) !== JSON.stringify(EXPECTED_DEPENDS[serviceName])) fail(`${serviceName.toUpperCase().replaceAll("-","_")}_DEPENDENCY_INVALID`);
    if (serviceName === "worker") {
      const metaMounts = (service.volumes ?? []).filter((entry) => entry?.target === "/run/zap-pronto-secrets/meta");
      if (metaMounts.length !== 1 || metaMounts[0].type !== "bind" || metaMounts[0].read_only !== true) fail("WORKER_META_SECRET_MOUNT_INVALID");
    }
    if (serviceName === "api") {
      const environment = service.environment ?? {};
      if (!/^(true|false)$/.test(String(environment.META_WEBHOOK_ENABLED ?? ""))) fail("API_META_WEBHOOK_ENABLED_INVALID");
      if (environment.META_APP_SECRET_FILE !== "/run/secrets/meta_app_secret" || environment.META_VERIFY_TOKEN_FILE !== "/run/secrets/meta_verify_token") fail("API_META_WEBHOOK_SECRET_PATH_INVALID");
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
  validateComposeInvariants(compose);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const envFile = process.argv[2];
  if (!envFile || !isAbsolute(envFile)) fail("ENV_FILE_ABSOLUTE_PATH_REQUIRED");
  await runPreflight(envFile);
  process.stdout.write("staging preflight passed\n");
}
