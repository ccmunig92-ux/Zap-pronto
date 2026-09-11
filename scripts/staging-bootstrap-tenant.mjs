import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

const MAX_DATABASE_URL_BYTES = 4096;
const MAX_CONFIG_BYTES = 16384;
const EXPECTED_FILE_MODE = 0o400;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNIT_CODE = /^[A-Z][A-Z0-9_-]{1,31}$/;
const PROVIDER_CODE = /^[a-z][a-z0-9_-]{1,62}$/;
const CLAIM = /^[A-Za-z][A-Za-z0-9_.:-]{0,126}$/;
const CONFIG_KEYS = Object.freeze([
  "tenantId", "tenantName", "unitId", "unitCode", "unitName", "adminUserId",
  "adminEmail", "adminDisplayName", "oidcProviderId", "oidcProviderCode", "oidcIssuer",
  "oidcAudience", "oidcOrganizationClaim", "oidcOrganizationValue", "oidcConfigReference",
  "oidcSubject",
]);

async function privateRegularFile(path, maxBytes, currentUid = process.getuid?.()) {
  let metadata;
  try { metadata = await lstat(path); }
  catch { throw new Error("BOOTSTRAP_FILE_UNREADABLE"); }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) {
    throw new Error("BOOTSTRAP_FILE_UNSAFE");
  }
  if (process.platform === "linux"
    && ((metadata.mode & 0o777) !== EXPECTED_FILE_MODE || metadata.uid !== currentUid)) {
    throw new Error("BOOTSTRAP_FILE_PERMISSIONS_INVALID");
  }
  return readFile(path, "utf8");
}

function requiredText(value, name, maximum = 160) {
  if (typeof value !== "string") throw new Error(`${name}_INVALID`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum) throw new Error(`${name}_INVALID`);
  return normalized;
}

function requiredUuid(value, name) {
  const normalized = requiredText(value, name, 36).toLowerCase();
  if (!UUID.test(normalized)) throw new Error(`${name}_INVALID`);
  return normalized;
}

function secureIssuer(value) {
  const issuer = requiredText(value, "OIDC_ISSUER", 2048);
  let parsed;
  try { parsed = new URL(issuer); } catch { throw new Error("OIDC_ISSUER_INVALID"); }
  if (issuer !== value || parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.href !== issuer) throw new Error("OIDC_ISSUER_INVALID");
  return issuer;
}

function opaqueConfigReference(value) {
  const reference = requiredText(value, "OIDC_CONFIG_REFERENCE", 512);
  let parsed;
  try { parsed = new URL(reference); } catch { throw new Error("OIDC_CONFIG_REFERENCE_INVALID"); }
  if (reference !== value || !/^[a-z][a-z0-9+.-]{1,31}:\/\//.test(reference)
    || parsed.username || parsed.password || parsed.search || parsed.hash
    || /[\u0000-\u0020\u007f]/u.test(reference) || reference.includes("@")) {
    throw new Error("OIDC_CONFIG_REFERENCE_INVALID");
  }
  return reference;
}

export function effectiveOidcConfig(env = process.env) {
  const issuerRaw = env.OIDC_ISSUER;
  const audienceRaw = env.OIDC_AUDIENCE;
  if (typeof issuerRaw !== "string" || typeof audienceRaw !== "string") {
    throw new Error("BOOTSTRAP_OIDC_RUNTIME_REQUIRED");
  }
  const issuer = secureIssuer(issuerRaw.trim());
  const audience = requiredText(audienceRaw, "OIDC_AUDIENCE", 512);
  if (/\s/.test(audience)) throw new Error("OIDC_AUDIENCE_INVALID");
  const claimRaw = env.OIDC_ORGANIZATION_CLAIM;
  const organizationClaim = claimRaw?.trim() || null;
  if (organizationClaim !== null && !CLAIM.test(organizationClaim)) {
    throw new Error("OIDC_ORGANIZATION_CLAIM_INVALID");
  }
  return Object.freeze({ issuer, audience, organizationClaim });
}

export function assertOidcBinding(config, effective) {
  if (!effective || config.oidcIssuer !== effective.issuer
    || config.oidcAudience !== effective.audience
    || config.oidcOrganizationClaim !== effective.organizationClaim) {
    throw new Error("BOOTSTRAP_OIDC_RUNTIME_MISMATCH");
  }
}

export function validateBootstrapConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("BOOTSTRAP_CONFIG_INVALID");
  const keys = Object.keys(input).sort();
  if (keys.length !== CONFIG_KEYS.length || keys.some((key, index) => key !== [...CONFIG_KEYS].sort()[index])) {
    throw new Error("BOOTSTRAP_CONFIG_KEYS_INVALID");
  }
  const tenantId = requiredUuid(input.tenantId, "TENANT_ID");
  const unitId = requiredUuid(input.unitId, "UNIT_ID");
  const adminUserId = requiredUuid(input.adminUserId, "ADMIN_USER_ID");
  const oidcProviderId = requiredUuid(input.oidcProviderId, "OIDC_PROVIDER_ID");
  if (new Set([tenantId, unitId, adminUserId, oidcProviderId]).size !== 4) {
    throw new Error("BOOTSTRAP_IDS_NOT_DISTINCT");
  }
  const unitCode = requiredText(input.unitCode, "UNIT_CODE", 32);
  if (!UNIT_CODE.test(unitCode)) throw new Error("UNIT_CODE_INVALID");
  const adminEmail = requiredText(input.adminEmail, "ADMIN_EMAIL", 320).toLowerCase();
  if (/\s/.test(adminEmail) || !/^[^\s@]+@[^\s@]+$/.test(adminEmail)) throw new Error("ADMIN_EMAIL_INVALID");
  const oidcProviderCode = requiredText(input.oidcProviderCode, "OIDC_PROVIDER_CODE", 63);
  if (!PROVIDER_CODE.test(oidcProviderCode)) throw new Error("OIDC_PROVIDER_CODE_INVALID");
  const oidcAudience = requiredText(input.oidcAudience, "OIDC_AUDIENCE", 512);
  if (/\s/.test(oidcAudience)) throw new Error("OIDC_AUDIENCE_INVALID");
  const oidcSubject = requiredText(input.oidcSubject, "OIDC_SUBJECT", 512);
  if (oidcSubject !== input.oidcSubject) throw new Error("OIDC_SUBJECT_INVALID");
  const oidcConfigReference = opaqueConfigReference(input.oidcConfigReference);
  const claim = input.oidcOrganizationClaim;
  const value = input.oidcOrganizationValue;
  if ((claim === null) !== (value === null)) throw new Error("OIDC_ORGANIZATION_PAIR_INVALID");
  let oidcOrganizationClaim = null;
  let oidcOrganizationValue = null;
  if (claim !== null) {
    oidcOrganizationClaim = requiredText(claim, "OIDC_ORGANIZATION_CLAIM", 127);
    oidcOrganizationValue = requiredText(value, "OIDC_ORGANIZATION_VALUE", 512);
    if (!CLAIM.test(oidcOrganizationClaim)) throw new Error("OIDC_ORGANIZATION_CLAIM_INVALID");
  }
  return Object.freeze({ tenantId, tenantName: requiredText(input.tenantName, "TENANT_NAME"),
    unitId, unitCode, unitName: requiredText(input.unitName, "UNIT_NAME"), adminUserId, adminEmail,
    adminDisplayName: requiredText(input.adminDisplayName, "ADMIN_DISPLAY_NAME"), oidcProviderId,
    oidcProviderCode, oidcIssuer: secureIssuer(input.oidcIssuer), oidcAudience,
    oidcOrganizationClaim, oidcOrganizationValue, oidcConfigReference, oidcSubject });
}

function postgresOwnerUrl(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error("DATABASE_URL_INVALID"); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname
    || !parsed.pathname.slice(1) || decodeURIComponent(parsed.username) !== "zap_pronto_owner"
    || !parsed.password) throw new Error("DATABASE_URL_INVALID");
  return raw;
}

export async function loadBootstrapInputs(env = process.env) {
  const databasePath = env.DATABASE_URL_FILE?.trim();
  const configPath = env.BOOTSTRAP_CONFIG_FILE?.trim();
  if (!databasePath) throw new Error("DATABASE_URL_FILE_REQUIRED");
  if (!configPath) throw new Error("BOOTSTRAP_CONFIG_FILE_REQUIRED");
  const [databaseRaw, configRaw] = await Promise.all([
    privateRegularFile(databasePath, MAX_DATABASE_URL_BYTES),
    privateRegularFile(configPath, MAX_CONFIG_BYTES),
  ]);
  let parsedConfig;
  try { parsedConfig = JSON.parse(configRaw); } catch { throw new Error("BOOTSTRAP_CONFIG_INVALID"); }
  const config = validateBootstrapConfig(parsedConfig);
  const effectiveOidc = effectiveOidcConfig(env);
  assertOidcBinding(config, effectiveOidc);
  return { databaseUrl: postgresOwnerUrl(databaseRaw.trim()), config, effectiveOidc };
}

const migrationChecksum = (sql) => createHash("sha256").update(sql.replace(/\r\n?/gu, "\n")).digest("hex");

export async function verifyMigrationState(client, directory = resolve("database", "migrations")) {
  const files = (await readdir(directory)).filter((file) => /^\d+_[a-z0-9_]+\.sql$/.test(file)).sort();
  const expected = new Map(await Promise.all(files.map(async (filename) =>
    [filename, migrationChecksum(await readFile(resolve(directory, filename), "utf8"))])));
  let result;
  try { result = await client.query("SELECT filename,checksum_sha256 FROM schema_migrations ORDER BY filename"); }
  catch { throw new Error("BOOTSTRAP_SCHEMA_UNAVAILABLE"); }
  if (result.rows.length !== expected.size) throw new Error("BOOTSTRAP_SCHEMA_VERSION_MISMATCH");
  for (const row of result.rows) {
    if (expected.get(row.filename) !== String(row.checksum_sha256).trim()) {
      throw new Error("BOOTSTRAP_SCHEMA_VERSION_MISMATCH");
    }
  }
}

export async function bootstrapInitialTenant(inputs, Client = pg.Client, migrationsDirectory) {
  assertOidcBinding(inputs.config, inputs.effectiveOidc);
  const client = new Client({ connectionString: inputs.databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [820260805]);
    await verifyMigrationState(client, migrationsDirectory);
    const config = inputs.config;
    const result = await client.query(`SELECT * FROM bootstrap_initial_tenant(
      $1::uuid,$2::text,$3::uuid,$4::text,$5::text,$6::uuid,$7::text,$8::text,
      $9::uuid,$10::text,$11::text,$12::text,$13::text,$14::text,$15::text,$16::text
    )`, [config.tenantId, config.tenantName, config.unitId, config.unitCode, config.unitName,
      config.adminUserId, config.adminEmail, config.adminDisplayName, config.oidcProviderId,
      config.oidcProviderCode, config.oidcIssuer, config.oidcAudience,
      config.oidcOrganizationClaim, config.oidcOrganizationValue, config.oidcConfigReference,
      config.oidcSubject]);
    if (result.rowCount !== 1 || typeof result.rows[0]?.replayed !== "boolean") {
      throw new Error("INITIAL_TENANT_BOOTSTRAP_INVALID_RESULT");
    }
    await client.query("COMMIT");
    return { replayed: result.rows[0].replayed };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { await client.end(); }
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--apply") {
    process.stderr.write("Usage (staging admin container only): node scripts/staging-bootstrap-tenant.mjs --apply\n");
    process.exitCode = 1;
    return;
  }
  try {
    const result = await bootstrapInitialTenant(await loadBootstrapInputs());
    process.stdout.write(result.replayed ? "INITIAL_TENANT_BOOTSTRAP_REPLAYED\n" : "INITIAL_TENANT_BOOTSTRAPPED\n");
  } catch {
    process.stderr.write("INITIAL_TENANT_BOOTSTRAP_FAILED\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
