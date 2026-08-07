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
    async connect() { calls.push({ text: "CONNECT" }); }
    async query(text, values) { calls.push({ text, values }); return { rows: [] }; }
    async end() { calls.push({ text: "END" }); }
  }
  await provisionRuntime({ adminUrl: "postgresql://owner:admin@postgres/db",
    runtimePassword: "never-log-this-secret", runtimeRole: "zap_pronto_runtime" }, FakeClient);
  assert.equal(calls.some(({ text }) => text.includes("never-log-this-secret")), false);
  assert.deepEqual(calls.filter(({ text }) => text === "COMMIT").length, 1);
  assert.deepEqual(calls.find(({ text }) => text.startsWith("SELECT set_config"))?.values,
    ["never-log-this-secret"]);
});
