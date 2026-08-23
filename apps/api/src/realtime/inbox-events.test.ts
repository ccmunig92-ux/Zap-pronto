import assert from "node:assert/strict";
import test from "node:test";
import type { TenantTransactionPool } from "@zap-pronto/core/database/tenant-transaction";
import { buildApp } from "../app.js";

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
