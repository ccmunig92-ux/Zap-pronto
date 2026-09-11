import { readFile, stat, lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const IMAGE = /^[^\s@]+(?:\/[^\s@]+)*@sha256:[a-f0-9]{64}$/;
const DATABASE_SECRET_NAMES = ["POSTGRES_PASSWORD_FILE", "DATABASE_MIGRATION_URL_FILE", "DATABASE_RUNTIME_URL_FILE", "DATABASE_WORKER_URL_FILE"];
const META_SECRET_NAMES = ["META_APP_SECRET_FILE", "META_VERIFY_TOKEN_FILE"];
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

function optionalEmailClaims(env) {
  const email = env.OIDC_EMAIL_CLAIM;
  const verified = env.OIDC_EMAIL_VERIFIED_CLAIM;
  const hasEmail = typeof email === "string" && email.length > 0;
  const hasVerified = typeof verified === "string" && verified.length > 0;
  if (hasEmail !== hasVerified) fail("OIDC_EMAIL_CLAIMS_PAIR_REQUIRED");
  if (!hasEmail) return;
  for (const [name, value, standard] of [["OIDC_EMAIL_CLAIM", email, "email"],
    ["OIDC_EMAIL_VERIFIED_CLAIM", verified, "email_verified"]]) {
    if (value === standard) continue;
    let parsed;
    try { parsed = new URL(value); } catch { fail(`${name}_INVALID`); }
    if (value !== value.trim() || value.length > 512 || /[\u0000-\u0020\u007f]/u.test(value)
      || parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash
      || parsed.pathname === "/" || parsed.href !== value) fail(`${name}_INVALID`);
  }
  if (email === verified) fail("OIDC_EMAIL_CLAIMS_DISTINCT_REQUIRED");
}

export function validateEnvironment(env, { metaEnabled = false } = {}) {
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
  optionalEmailClaims(env);
  if (metaEnabled && !/^v\d+\.\d+$/.test(required(env, "META_GRAPH_API_VERSION"))) fail("META_GRAPH_API_VERSION_INVALID");
}

export async function validateSecrets(env, repoRoot, { metaEnabled = false } = {}) {
  if (typeof process.getuid !== "function") fail("POSIX_SECRET_METADATA_REQUIRED");
  const root = await realpath(repoRoot);
  if (metaEnabled) await validateMetaSecretRoot(required(env, "META_WHATSAPP_SECRET_ROOT"), root);
  const seen = new Set();
  for (const name of [...DATABASE_SECRET_NAMES, ...(metaEnabled ? META_SECRET_NAMES : [])]) {
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
  if (typeof value !== "number" && typeof value !== "string") return NaN;
  const match = String(value ?? "").match(/^(\d+(?:\.\d+)?)([KMG])?$/i);
  if (!match) return NaN;
  // Compose's rendered JSON expresses unitless memory in bytes, not MiB.
  return Number(match[1]) * (match[2] ? { K: 1 / 1024, M: 1, G: 1024 }[match[2].toUpperCase()] : 1 / 1048576);
}

export function validateResources(compose) {
  for (const [service, minimum] of Object.entries(MINIMUMS)) {
    const limits = compose.services?.[service]?.deploy?.resources?.limits;
    const cpus = typeof limits?.cpus === "number" || typeof limits?.cpus === "string" ? Number(limits.cpus) : NaN;
    const memory = memoryMiB(limits?.memory);
    if (!Number.isFinite(cpus) || !Number.isFinite(memory) || cpus < minimum.cpus || memory < minimum.memory) {
      fail(`${service.toUpperCase().replaceAll("-", "_")}_RESOURCES_BELOW_MINIMUM`);
    }
  }
}

const BASE_EXPECTED_SECRETS = Object.freeze({
  postgres:["postgres_password"], migrate:["database_migration_url"],
  "provision-runtime":["database_migration_url","database_runtime_url","database_worker_url"],
  api:["database_runtime_url"],worker:["database_worker_url"],web:[],
});
const EXPECTED_DEPENDS = Object.freeze({
  postgres:{}, migrate:{postgres:"service_healthy"}, "provision-runtime":{migrate:"service_completed_successfully"},
  api:{"provision-runtime":"service_completed_successfully"},worker:{"provision-runtime":"service_completed_successfully"},web:{api:"service_healthy"},
});
const EXPECTED_NETWORKS = Object.freeze({ postgres:["data"], migrate:["data"], "provision-runtime":["data"],
  api:["app","data"],worker:["data"],web:["app"] });

export function validateComposeInvariants(compose, { metaEnabled = false } = {}) {
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
    const expectedSecrets = [...BASE_EXPECTED_SECRETS[serviceName]];
    if (metaEnabled && serviceName === "api") expectedSecrets.push("meta_app_secret", "meta_verify_token");
    const secrets = (service.secrets ?? []).map((entry) => typeof entry === "string" ? entry : entry.source).sort();
    if (JSON.stringify(secrets) !== JSON.stringify(expectedSecrets.sort())) fail(`${serviceName.toUpperCase().replaceAll("-","_")}_SECRETS_INVALID`);
    const networks = Object.keys(service.networks ?? {}).sort();
    if (JSON.stringify(networks) !== JSON.stringify([...EXPECTED_NETWORKS[serviceName]].sort())) fail(`${serviceName.toUpperCase().replaceAll("-","_")}_NETWORKS_INVALID`);
    const depends = Object.fromEntries(Object.entries(service.depends_on ?? {}).map(([name,value]) => [name,value.condition]));
    if (JSON.stringify(depends) !== JSON.stringify(EXPECTED_DEPENDS[serviceName])) fail(`${serviceName.toUpperCase().replaceAll("-","_")}_DEPENDENCY_INVALID`);
    if (serviceName === "worker") {
      const metaMounts = (service.volumes ?? []).filter((entry) => entry?.target === "/run/zap-pronto-secrets/meta");
      if (metaEnabled) {
        if (metaMounts.length !== 1 || metaMounts[0].type !== "bind" || metaMounts[0].read_only !== true) fail("WORKER_META_SECRET_MOUNT_INVALID");
        if (service.environment?.OUTBOUND_WORKER_ENABLED !== "true" || service.environment?.META_WHATSAPP_SECRET_ROOT !== "/run/zap-pronto-secrets/meta") fail("WORKER_META_CONFIGURATION_INVALID");
      } else if (metaMounts.length || service.environment?.OUTBOUND_WORKER_ENABLED !== "false") fail("WORKER_META_DISABLED_CONFIGURATION_INVALID");
    }
    if (serviceName === "api") {
      const environment = service.environment ?? {};
      optionalEmailClaims(environment);
      if (environment.META_WEBHOOK_ENABLED !== String(metaEnabled)) fail("API_META_WEBHOOK_ENABLED_INVALID");
      if (metaEnabled) {
        if (environment.META_APP_SECRET_FILE !== "/run/secrets/meta_app_secret" || environment.META_VERIFY_TOKEN_FILE !== "/run/secrets/meta_verify_token") fail("API_META_WEBHOOK_SECRET_PATH_INVALID");
      } else if (environment.META_APP_SECRET_FILE || environment.META_VERIFY_TOKEN_FILE) fail("API_META_WEBHOOK_SECRET_PATH_INVALID");
    }
  }
}

export async function runPreflight(envFile, repoRoot = resolve(import.meta.dirname, ".."), { metaEnabled = false } = {}) {
  const env = parseEnv(await readFile(envFile, "utf8"));
  validateEnvironment(env, { metaEnabled });
  await validateSecrets(env, repoRoot, { metaEnabled });
  const composeArgs = ["compose", "--env-file", envFile, "-f", resolve(repoRoot, "deploy/staging/compose.yaml")];
  if (metaEnabled) composeArgs.push("-f", resolve(repoRoot, "deploy/staging/compose.meta.yaml"));
  const rendered = spawnSync("docker", [...composeArgs, "config", "--format", "json"], { encoding: "utf8" });
  if (rendered.status !== 0) fail("COMPOSE_INVALID");
  let compose; try { compose = JSON.parse(rendered.stdout); } catch { fail("COMPOSE_INVALID"); }
  validateResources(compose);
  validateComposeInvariants(compose, { metaEnabled });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const envFile = process.argv[2];
  const metaEnabled = process.argv[3] === "--meta";
  if (!envFile || !isAbsolute(envFile) || process.argv.length > (metaEnabled ? 4 : 3)) fail("USAGE_INVALID");
  await runPreflight(envFile, resolve(import.meta.dirname, ".."), { metaEnabled });
  process.stdout.write("staging preflight passed\n");
}
