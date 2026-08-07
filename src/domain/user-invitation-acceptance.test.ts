import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acceptUserInvitation } from "./user-invitation-acceptance.js";

describe("acceptUserInvitation", () => {
  it("envia apenas digest do token e retorna a sessão criada na mesma transação", async () => {
    const token = Buffer.alloc(32, 0xab).toString("base64url");
    const calls: { sql: string; values?: unknown[] }[] = [];
    const client = { query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, ...(values ? { values } : {}) });
      if (sql.includes("accept_user_invitation_oidc")) return { rowCount: 1, rows: [{ replayed: false }] };
      if (sql.includes("FROM users account")) return { rows: [{ user_id: "10000000-0000-4000-8000-000000000001",
        email: "person@example.test", display_name: "Person", tenant_id: "20000000-0000-4000-8000-000000000001",
        tenant_name: "Clinic" }] };
      if (sql.includes("app_role_permissions")) return { rows: [] };
      if (sql.includes("FROM user_units membership") && sql.includes("membership.role")) return { rows: [{
        unit_id: "30000000-0000-4000-8000-000000000001", unit_code: "MAIN", unit_name: "Main", role: "ATTENDANT",
      }] };
      return { rows: [] };
    } };
    const result = await acceptUserInvitation(client, { invitationToken: token, idempotencyKey: "accept-command",
      principal: { issuer: "https://issuer.example", audience: "zap-pronto", subject: "subject",
        verifiedEmail: "Person@Example.Test", correlationId: "accept-request-12345678" } });
    assert.equal(result.replayed, false);
    const values = calls[0]!.values ?? [];
    assert.equal(values.includes(token), false);
    assert.ok(Buffer.isBuffer(values[2]) && (values[2] as Buffer).length === 32);
    assert.equal(values[9], "person@example.test");
  });

  it("rejeita token e identidade sem email verificado antes do SQL", async () => {
    const client = { query: async () => { throw new Error("SHOULD_NOT_QUERY"); } };
    const principal = { issuer: "https://issuer.example", audience: "zap-pronto", subject: "subject",
      correlationId: "accept-request-12345678" };
    await assert.rejects(acceptUserInvitation(client, { invitationToken: "invalid", idempotencyKey: "accept-command",
      principal }), /INVALID_INVITATION_TOKEN/);
    await assert.rejects(acceptUserInvitation(client, { invitationToken: Buffer.alloc(32).toString("base64url"),
      idempotencyKey: "accept-command", principal }), /VERIFIED_EMAIL_REQUIRED/);
  });
});
