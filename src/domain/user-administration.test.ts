import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changeAdministrativeUserStatus, listAdministrativeUsers, reissueUserInvitation } from "./user-administration.js";

const userId = "10000000-0000-4000-8000-000000000001";
const invitationId = "20000000-0000-4000-8000-000000000001";

describe("user administration", () => {
  it("rejeita cursor e limite inválidos antes do SQL", async () => {
    const client = { query: async () => { throw new Error("SHOULD_NOT_QUERY"); } };
    await assert.rejects(listAdministrativeUsers(client, { limit: 101 }), /INVALID_PAGE_LIMIT/);
    await assert.rejects(listAdministrativeUsers(client, { cursor: "not-json" }), /INVALID_PAGE_CURSOR/);
  });

  it("normaliza ação e envia fingerprint, não dados derivados do cliente", async () => {
    let values: readonly unknown[] = [];
    const client = { query: async (_sql: string, parameters?: unknown[]) => {
      values = parameters ?? [];
      return { rowCount: 1, rows: [{ user_id: userId, status: "BLOCKED", version: 2, replayed: false }] };
    } };
    const result = await changeAdministrativeUserStatus(client, { idempotencyKey: " status-command ",
      userId, expectedVersion: 1, action: "BLOCK", reason: " risco operacional " });
    assert.deepEqual(result, { id: userId, status: "BLOCKED", version: 2, replayed: false });
    assert.equal(values[0], "status-command");
    assert.ok(Buffer.isBuffer(values[1]) && (values[1] as Buffer).length === 32);
    assert.equal(values[4], "BLOCKED");
    assert.equal(values[5], "risco operacional");
  });

  it("reemite com token de uso único sem enviar o bruto ao banco", async () => {
    let values: readonly unknown[] = [];
    const client = { query: async (_sql: string, parameters?: unknown[]) => {
      values = parameters ?? [];
      return { rowCount: 1, rows: [{ id: invitationId, email: "a@example.test", display_name: "A",
        status: "PENDING", expires_at: new Date(), oidc_provider_code: "primary", assignments: [], replayed: false }] };
    } };
    const result = await reissueUserInvitation(client, { idempotencyKey: "reissue-command", invitationId,
      expiresAt: new Date(Date.now() + 60_000), reason: "token perdido" });
    assert.equal(result.token?.length, 43);
    assert.equal(values.includes(result.token), false);
    assert.ok(Buffer.isBuffer(values[5]) && (values[5] as Buffer).length === 32);
  });
});
