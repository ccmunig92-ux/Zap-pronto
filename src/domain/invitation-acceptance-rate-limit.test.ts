import assert from "node:assert/strict";
import { it } from "node:test";
import { consumeInvitationAcceptanceRateLimit } from "./invitation-acceptance-rate-limit.js";

it("consome rate limit em transação própria sem armazenar claims", async () => {
  const queries: { sql: string; values?: unknown[] }[] = [];
  const pool = { async connect() { return { async query(sql: string, values?: unknown[]) {
    queries.push({ sql, ...(values ? { values } : {}) });
    if (sql.includes("consume_invitation_acceptance_rate_limit")) return { rowCount: 1, rows: [{
      allowed: true, remaining: 9, retry_after_seconds: 0, reset_at: new Date("2030-01-01T00:15:00Z"),
    }] };
    return { rows: [] };
  }, release() { queries.push({ sql: "RELEASE" }); } }; } };
  const result = await consumeInvitationAcceptanceRateLimit(pool, { issuer: "https://issuer.example",
    audience: "zap-pronto", subject: "subject", organizationClaim: "org_id", organizationValue: "clinic-a",
    correlationId: "rate-limit-request-12345678" });
  assert.equal(result.allowed, true); assert.equal(result.remaining, 9);
  const call = queries.find(({ sql }) => sql.includes("consume_invitation_acceptance_rate_limit"));
  assert.ok(Buffer.isBuffer(call?.values?.[0]) && (call?.values?.[0] as Buffer).length === 32);
  assert.doesNotMatch(JSON.stringify(call?.values), /issuer|subject|clinic-a/);
  assert.deepEqual(queries.slice(-2).map(({ sql }) => sql), ["COMMIT", "RELEASE"]);
});
