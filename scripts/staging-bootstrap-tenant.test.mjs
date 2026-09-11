import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertOidcBinding, bootstrapInitialTenant, effectiveOidcConfig, loadBootstrapInputs, validateBootstrapConfig,
  verifyMigrationState } from "./staging-bootstrap-tenant.mjs";

const valid = Object.freeze({
  tenantId: "10000000-0000-4000-8000-000000000001", tenantName: "Clínica Staging",
  unitId: "20000000-0000-4000-8000-000000000001", unitCode: "MATRIZ", unitName: "Matriz",
  adminUserId: "30000000-0000-4000-8000-000000000001", adminEmail: "Admin@Example.test",
  adminDisplayName: "Admin Staging", oidcProviderId: "40000000-0000-4000-8000-000000000001",
  oidcProviderCode: "auth0", oidcIssuer: "https://tenant.example.auth0.com/",
  oidcAudience: "zap-pronto", oidcOrganizationClaim: null, oidcOrganizationValue: null,
  oidcConfigReference: "auth0://tenant/zap-pronto", oidcSubject: "auth0|staging-admin",
});

test("normalizes safe bootstrap fields and preserves the exact OIDC issuer and subject", () => {
  const config = validateBootstrapConfig(valid);
  assert.equal(config.adminEmail, "admin@example.test");
  assert.equal(config.oidcIssuer, valid.oidcIssuer);
  assert.equal(config.oidcSubject, valid.oidcSubject);
  assert.equal(config.oidcOrganizationClaim, null);
});

test("rejects unknown fields, repeated IDs, insecure issuer and incomplete organization pair", () => {
  assert.throws(() => validateBootstrapConfig({ ...valid, unexpected: true }), /KEYS_INVALID/);
  assert.throws(() => validateBootstrapConfig({ ...valid, unitId: valid.tenantId }), /IDS_NOT_DISTINCT/);
  assert.throws(() => validateBootstrapConfig({ ...valid, oidcIssuer: "http://identity.test/" }), /ISSUER_INVALID/);
  assert.throws(() => validateBootstrapConfig({ ...valid, oidcSubject: " bootstrap-subject" }), /SUBJECT_INVALID/);
  assert.throws(() => validateBootstrapConfig({ ...valid, oidcOrganizationClaim: "org_id" }), /PAIR_INVALID/);
  for (const oidcConfigReference of ["auth0://user:password@tenant/app", "auth0://tenant/app?secret=x",
    "auth0://tenant/app#fragment", " auth0://tenant/app", "auth0://tenant/app\nnext"]) {
    assert.throws(() => validateBootstrapConfig({ ...valid, oidcConfigReference }), /CONFIG_REFERENCE_INVALID/);
  }
});

test("requires exact binding to the effective OIDC runtime before database access", async () => {
  const effective = effectiveOidcConfig({ OIDC_ISSUER:valid.oidcIssuer, OIDC_AUDIENCE:valid.oidcAudience,
    OIDC_ORGANIZATION_CLAIM:"" });
  assert.doesNotThrow(() => assertOidcBinding(validateBootstrapConfig(valid), effective));
  for (const runtime of [
    { ...effective, issuer:"https://other.example.test/" },
    { ...effective, audience:"other-audience" },
    { ...effective, organizationClaim:"org_id" },
  ]) assert.throws(() => assertOidcBinding(validateBootstrapConfig(valid), runtime), /RUNTIME_MISMATCH/);
  class MustNotConnect { constructor() { throw new Error("DATABASE_ACCESSED"); } }
  await assert.rejects(bootstrapInitialTenant({ databaseUrl:"postgresql://owner:secret@postgres/db",
    config:validateBootstrapConfig(valid), effectiveOidc:{...effective,audience:"wrong"} }, MustNotConnect),
  /RUNTIME_MISMATCH/);
});

test("loads both sensitive inputs from files and requires the canonical owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zap-bootstrap-"));
  const database = join(directory, "database-url");
  const runtimeDatabase = join(directory, "runtime-database-url");
  const config = join(directory, "bootstrap.json");
  await writeFile(database, "postgresql://zap_pronto_owner:private@postgres:5432/zap_pronto\n", { mode: 0o400 });
  await writeFile(config, JSON.stringify(valid), { mode: 0o400 });
  const oidcEnv = { OIDC_ISSUER:valid.oidcIssuer, OIDC_AUDIENCE:valid.oidcAudience,
    OIDC_ORGANIZATION_CLAIM:"" };
  const loaded = await loadBootstrapInputs({ DATABASE_URL_FILE: database, BOOTSTRAP_CONFIG_FILE: config, ...oidcEnv });
  assert.equal(loaded.config.adminEmail, "admin@example.test");
  await writeFile(runtimeDatabase, "postgresql://zap_pronto_runtime:private@postgres:5432/zap_pronto\n", { mode: 0o400 });
  await assert.rejects(loadBootstrapInputs({ DATABASE_URL_FILE: runtimeDatabase, BOOTSTRAP_CONFIG_FILE: config, ...oidcEnv }),
    /DATABASE_URL_INVALID/);
});

test("migration verification rejects pending, unknown and divergent schema state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zap-bootstrap-migrations-"));
  await writeFile(join(directory, "0001_test.sql"), "SELECT 1;\n");
  const hash = "b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd";
  await verifyMigrationState({ query: async () => ({ rows: [{ filename: "0001_test.sql", checksum_sha256: hash }] }) }, directory);
  await assert.rejects(verifyMigrationState({ query: async () => ({ rows: [] }) }, directory), /VERSION_MISMATCH/);
  await assert.rejects(verifyMigrationState({ query: async () => ({ rows: [{ filename: "0001_test.sql",
    checksum_sha256: "0".repeat(64) }] }) }, directory), /VERSION_MISMATCH/);
});

test("bootstrap uses only parameter values, commits one result and exposes no configuration in SQL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zap-bootstrap-call-"));
  await writeFile(join(directory, "0001_test.sql"), "SELECT 1;\n");
  const calls = [];
  class FakeClient {
    async connect() { calls.push({ text: "CONNECT" }); }
    async query(text, values) {
      calls.push({ text, values });
      if (text.startsWith("SELECT filename")) return { rows: [{ filename: "0001_test.sql",
        checksum_sha256: "b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd" }] };
      if (text.includes("bootstrap_initial_tenant")) return { rowCount: 1, rows: [{ replayed: false }] };
      return { rows: [] };
    }
    async end() { calls.push({ text: "END" }); }
  }
  const result = await bootstrapInitialTenant({ databaseUrl: "postgresql://owner:secret@postgres/db",
    config: validateBootstrapConfig(valid), effectiveOidc:effectiveOidcConfig({
      OIDC_ISSUER:valid.oidcIssuer, OIDC_AUDIENCE:valid.oidcAudience }) }, FakeClient, directory);
  assert.deepEqual(result, { replayed: false });
  assert.equal(calls.some(({ text }) => text.includes(valid.adminEmail) || text.includes(valid.oidcSubject)), false);
  assert.equal(calls.some(({ text }) => text === "COMMIT"), true);
  assert.equal(calls.find(({ text }) => text.includes("bootstrap_initial_tenant"))?.values?.length, 16);
});

test("staging migrate receives the same effective OIDC binding as the API", async () => {
  const compose = await readFile(new URL("../deploy/staging/compose.yaml", import.meta.url), "utf8");
  const migrate = compose.match(/\r?\n  migrate:\r?\n([\s\S]*?)\r?\n  provision-runtime:/)?.[1];
  assert.ok(migrate);
  for (const name of ["OIDC_ISSUER", "OIDC_AUDIENCE", "OIDC_ORGANIZATION_CLAIM"]) {
    assert.equal(migrate.includes(`${name}: \${`), true);
  }
});

test("CLI refuses execution without explicit apply and never prints inputs", () => {
  const script = fileURLToPath(new URL("./staging-bootstrap-tenant.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^Usage/);
});

test("CLI reports an OIDC mismatch without printing either configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zap-bootstrap-cli-mismatch-"));
  const database = join(directory, "database-url");
  const config = join(directory, "bootstrap.json");
  await writeFile(database, "postgresql://zap_pronto_owner:private@postgres:5432/zap_pronto\n", { mode:0o400 });
  await writeFile(config, JSON.stringify(valid), { mode:0o400 });
  const script = fileURLToPath(new URL("./staging-bootstrap-tenant.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--apply"], { encoding:"utf8", env:{...process.env,
    DATABASE_URL_FILE:database, BOOTSTRAP_CONFIG_FILE:config, OIDC_ISSUER:"https://wrong.example.test/",
    OIDC_AUDIENCE:valid.oidcAudience, OIDC_ORGANIZATION_CLAIM:""} });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "INITIAL_TENANT_BOOTSTRAP_FAILED\n");
  assert.equal(result.stderr.includes(valid.oidcIssuer) || result.stderr.includes("wrong.example"), false);
});
