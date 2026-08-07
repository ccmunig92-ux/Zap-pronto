import assert from "node:assert/strict";
import test from "node:test";
import { loadProvisioningConfig, provisionRuntime } from "./db-provision-runtime.mjs";

test("accepts matching admin and restricted runtime PostgreSQL URLs", async () => {
  const config = await loadProvisioningConfig({
    DATABASE_URL: "postgresql://owner:admin-secret@postgres:5432/zap_pronto",
    DATABASE_RUNTIME_URL: "postgresql://zap_pronto_runtime:runtime-secret@postgres:5432/zap_pronto",
  });
  assert.equal(config.runtimeRole, "zap_pronto_runtime");
  assert.equal(config.runtimePassword, "runtime-secret");
  assert.equal(config.runtimeUrl, "postgresql://zap_pronto_runtime:runtime-secret@postgres:5432/zap_pronto");
});

test("rejects target mismatch, unexpected role and missing password", async () => {
  const admin = "postgresql://owner:admin-secret@postgres:5432/zap_pronto";
  await assert.rejects(loadProvisioningConfig({ DATABASE_URL: admin,
    DATABASE_RUNTIME_URL: "postgresql://zap_pronto_runtime:secret@other:5432/zap_pronto" }),
  /DATABASE_TARGET_MISMATCH/);
  await assert.rejects(loadProvisioningConfig({ DATABASE_URL: admin,
    DATABASE_RUNTIME_URL: "postgresql://owner:secret@postgres:5432/zap_pronto" }),
  /DATABASE_RUNTIME_URL_USERNAME_INVALID/);
  await assert.rejects(loadProvisioningConfig({ DATABASE_URL: admin,
    DATABASE_RUNTIME_URL: "postgresql://zap_pronto_runtime@postgres:5432/zap_pronto" }),
  /DATABASE_RUNTIME_URL_PASSWORD_REQUIRED/);
});

test("rejects ambiguous secret sources", async () => {
  await assert.rejects(loadProvisioningConfig({ DATABASE_URL: "postgresql://owner:x@postgres/db",
    DATABASE_URL_FILE: "ignored", DATABASE_RUNTIME_URL: "postgresql://zap_pronto_runtime:y@postgres/db" }),
  /DATABASE_URL_SOURCE_CONFLICT/);
});

test("keeps the runtime password out of SQL text and commits provisioning", async () => {
  const calls = [];
  class FakeClient {
    constructor(options) { this.connectionString = options.connectionString; }
    async connect() { calls.push({ text: "CONNECT" }); }
    async query(text, values) {
      calls.push({ text, values, connectionString: this.connectionString });
      if (text.includes("AS valid_membership_count")) return { rows: [{ valid_membership_count: 1,
        total_membership_count: 1, direct_acl_count: 0, owned_object_count: 0, hardened_role_count: 1 }] };
      if (text.includes("session_user = $1")) return { rows: [{ session_is_runtime: true, role_is_api: true }] };
      return { rows: [] };
    }
    async end() { calls.push({ text: "END" }); }
  }
  await provisionRuntime({ adminUrl: "postgresql://owner:admin@postgres/db",
    runtimeUrl: "postgresql://zap_pronto_runtime:never-log-this-secret@postgres/db",
    runtimePassword: "never-log-this-secret", runtimeRole: "zap_pronto_runtime" }, FakeClient);
  assert.equal(calls.some(({ text }) => text.includes("never-log-this-secret")), false);
  assert.deepEqual(calls.filter(({ text }) => text === "COMMIT").length, 1);
  assert.deepEqual(calls.find(({ text }) => text.startsWith("SELECT set_config"))?.values,
    ["never-log-this-secret"]);
  assert.equal(calls.some(({ text }) => text === "SET LOCAL ROLE zap_pronto_api"), true);
  const hardeningSql = calls.find(({ text }) => text.includes("REVOKE ALL PRIVILEGES ON ALL TABLES"))?.text;
  assert.match(hardeningSql, /type\.typelem = 0/);
  assert.match(hardeningSql, /type\.typrelid = 0/);
  const verificationSql = calls.find(({ text }) => text.includes("AS valid_membership_count"))?.text;
  assert.match(verificationSql, /object\.typelem = 0 AND object\.typrelid = 0/);
});

test("rolls back and fails closed when privilege drift remains", async () => {
  const calls = [];
  class DriftClient {
    async connect() {}
    async query(text) {
      calls.push(text);
      if (text.includes("AS valid_membership_count")) return { rows: [{ valid_membership_count: 1,
        total_membership_count: 1, direct_acl_count: 1, owned_object_count: 0, hardened_role_count: 1 }] };
      return { rows: [] };
    }
    async end() {}
  }
  await assert.rejects(provisionRuntime({ adminUrl: "postgresql://owner:admin@postgres/db",
    runtimeUrl: "postgresql://zap_pronto_runtime:secret@postgres/db", runtimePassword: "secret",
    runtimeRole: "zap_pronto_runtime" }, DriftClient), /RUNTIME_ROLE_PRIVILEGE_DRIFT/);
  assert.equal(calls.includes("ROLLBACK"), true);
  assert.equal(calls.includes("COMMIT"), false);
});
