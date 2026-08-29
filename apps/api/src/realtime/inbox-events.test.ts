import assert from "node:assert/strict";
import test from "node:test";
import type { TenantTransactionPool } from "@zap-pronto/core/database/tenant-transaction";
import { buildApp } from "../app.js";
import { EventEmitter } from "node:events";
import type { InboxNotificationConnection } from "./inbox-events.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const unitId = "33333333-3333-4333-8333-333333333333";

test("realtime endpoint keeps authorization transactional and reports unavailable infrastructure", async () => {
  const pool: TenantTransactionPool = {
    async connect() {
      return {
        async query(sql: string) {
          if (sql.includes("resolve_oidc_principal")) return { rows: [{ tenant_id: tenantId, user_id: "22222222-2222-4222-8222-222222222222" }] };
          if (sql.includes("current_actor_has_permission")) return { rows: [{ allowed: true }] };
          if (sql.includes("current_app_tenant_id")) return { rows: [{ tenantId }] };
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const app = await buildApp({ pool, identityVerifier: {
    async verifyBearer() { return { issuer: "https://issuer.example", audience: "zap-pronto", subject: "subject-1" }; },
  } });
  const response = await app.inject({
    method: "GET", url: `/v1/inbox/events?unitId=${unitId}`,
    headers: { authorization: "Bearer token" },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().type, "urn:zap-pronto:error:realtime-unavailable");
  await app.close();
});

test("realtime endpoint reports LISTEN failure and releases the dedicated connection", async () => {
  const pool: TenantTransactionPool = {
    async connect() {
      return {
        async query(sql: string) {
          if (sql.includes("resolve_oidc_principal")) return { rows: [{ tenant_id: tenantId, user_id: "22222222-2222-4222-8222-222222222222" }] };
          if (sql.includes("current_actor_has_permission")) return { rows: [{ allowed: true }] };
          if (sql.includes("current_app_tenant_id")) return { rows: [{ tenantId }] };
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  let released = 0;
  const emitter = new EventEmitter();
  const notificationConnection = Object.assign(emitter, {
    async query(sql: string) { if (sql.startsWith("LISTEN ")) throw new Error("database unavailable"); return { rows: [] }; },
    release() { released += 1; },
  });
  const app = await buildApp({
    pool,
    notificationPool: { async connect() { return notificationConnection; } },
    identityVerifier: { async verifyBearer() { return { issuer: "https://issuer.example", audience: "zap-pronto", subject: "subject-1" }; } },
  });
  const response = await app.inject({ method: "GET", url: `/v1/inbox/events?unitId=${unitId}`, headers: { authorization: "Bearer token" } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().type, "urn:zap-pronto:error:realtime-unavailable");
  assert.equal(released, 1);
  assert.equal(emitter.listenerCount("notification"), 0);
  assert.equal(emitter.listenerCount("error"), 0);
  await app.close();
});

test("realtime endpoint maps notification connection failures to 503", async () => {
  const pool: TenantTransactionPool = {
    async connect() {
      return {
        async query(sql: string) {
          if (sql.includes("resolve_oidc_principal")) return { rows: [{ tenant_id: tenantId, user_id: "22222222-2222-4222-8222-222222222222" }] };
          if (sql.includes("current_actor_has_permission")) return { rows: [{ allowed: true }] };
          if (sql.includes("current_app_tenant_id")) return { rows: [{ tenantId }] };
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const app = await buildApp({
    pool,
    notificationPool: { async connect() { throw new Error("database unavailable"); } },
    identityVerifier: { async verifyBearer() { return { issuer: "https://issuer.example", audience: "zap-pronto", subject: "subject-1" }; } },
  });
  const response = await app.inject({ method: "GET", url: `/v1/inbox/events?unitId=${unitId}`, headers: { authorization: "Bearer token" } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().type, "urn:zap-pronto:error:realtime-unavailable");
  await app.close();
});

test("realtime endpoint times out notification connection and releases a late result", async () => {
  const pool: TenantTransactionPool = {
    async connect() {
      return {
        async query(sql: string) {
          if (sql.includes("resolve_oidc_principal")) return { rows: [{ tenant_id: tenantId, user_id: "22222222-2222-4222-8222-222222222222" }] };
          if (sql.includes("current_actor_has_permission")) return { rows: [{ allowed: true }] };
          if (sql.includes("current_app_tenant_id")) return { rows: [{ tenantId }] };
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  let resolveConnection: (connection: InboxNotificationConnection) => void = () => undefined;
  const connectionPromise = new Promise<InboxNotificationConnection>((resolve) => { resolveConnection = resolve; });
  let released = 0;
  const app = await buildApp({
    pool,
    notificationConnectTimeoutMs: 10,
    notificationPool: { async connect() { return connectionPromise; } },
    identityVerifier: { async verifyBearer() { return { issuer: "https://issuer.example", audience: "zap-pronto", subject: "subject-1" }; } },
  });
  const response = await app.inject({ method: "GET", url: `/v1/inbox/events?unitId=${unitId}`, headers: { authorization: "Bearer token" } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().type, "urn:zap-pronto:error:realtime-unavailable");
  resolveConnection({
    async query() { return { rows: [] }; },
    on() { return this; },
    removeListener() { return this; },
    release() { released += 1; },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(released, 1);
  await app.close();
});

test("realtime endpoint coalesces notifications received while initializing", async () => {
  const pool: TenantTransactionPool = {
    async connect() {
      return {
        async query(sql: string) {
          if (sql.includes("resolve_oidc_principal")) return { rows: [{ tenant_id: tenantId, user_id: "22222222-2222-4222-8222-222222222222" }] };
          if (sql.includes("current_actor_has_permission")) return { rows: [{ allowed: true }] };
          if (sql.includes("current_app_tenant_id")) return { rows: [{ tenantId }] };
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  let releaseListen!: () => void;
  const listenReady = new Promise<void>((resolve) => { releaseListen = resolve; });
  const emitter = new EventEmitter();
  const notificationConnection = Object.assign(emitter, {
    async query(sql: string) { if (sql.startsWith("LISTEN ")) await listenReady; return { rows: [] }; },
    release() {},
  });
  const app = await buildApp({
    pool,
    notificationPool: { async connect() { return notificationConnection; } },
    identityVerifier: { async verifyBearer() { return { issuer: "https://issuer.example", audience: "zap-pronto", subject: "subject-1" }; } },
  });
  const responsePromise = app.inject({ method: "GET", url: `/v1/inbox/events?unitId=${unitId}`, headers: { authorization: "Bearer token" } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  emitter.emit("notification", { channel: "zap_pronto_inbox", payload: JSON.stringify({ tenantId, unitId, kind: "messages", entityId: "60000000-0000-4000-8000-000000000001" }) });
  emitter.emit("notification", { channel: "zap_pronto_inbox", payload: JSON.stringify({ tenantId, unitId, kind: "messages", entityId: "60000000-0000-4000-8000-000000000001" }) });
  emitter.emit("notification", { channel: "zap_pronto_inbox", payload: JSON.stringify({ tenantId, unitId, kind: "handoffs", entityId: "60000000-0000-4000-8000-000000000002" }) });
  releaseListen();
  setImmediate(() => emitter.emit("error", new Error("listener failed")));
  const response = await responsePromise;
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.match(/event: inbox-change/g)?.length, 2);
  assert.match(response.body, /60000000-0000-4000-8000-000000000001/);
  assert.match(response.body, /60000000-0000-4000-8000-000000000002/);
  await app.close();
});
