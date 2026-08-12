import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { changeAdministrativeUserStatus, changeUnitMembership, listAdministrativeUsers, listUnitMembershipCatalog,
  reissueUserInvitation, unitMembershipFingerprint } from "./user-administration.js";

const userId = "10000000-0000-4000-8000-000000000001";
const invitationId = "20000000-0000-4000-8000-000000000001";
const unitId = "30000000-0000-4000-8000-000000000001";

describe("user administration", () => {
  it("conta somente memberships ACTIVE e apresenta lifecycle administrativo", async () => {
    let statement = "";
    const client = { query: async (sql: string) => {
      statement = sql;
      return { rowCount: 1, rows: [{ id: userId, email: "active@example.test", display_name: "Active",
        status: "ACTIVE", version: 1, memberships: [], is_self: false, is_last_admin: false }] };
    } };

    await listAdministrativeUsers(client);

    assert.match(statement, /membership\.status\s*=\s*'ACTIVE'/,
      "a contagem administrativa deve ignorar memberships revogadas");
    assert.match(statement, /own_membership\.status\s*=\s*'ACTIVE'/,
      "a proteção do último administrador deve ignorar memberships revogadas");
    assert.doesNotMatch(statement, /LEFT JOIN user_units membership[^\n]+membership\.status\s*=\s*'ACTIVE'/,
      "o DTO administrativo precisa apresentar memberships revogadas para reativação");
    assert.match(statement,/membership\.version/);assert.match(statement,/REACTIVATE/);
  });

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

  it("lista catálogo estreito por unidade sem email e preserva ações calculadas no servidor", async () => {
    const calls: { sql: string; values: readonly unknown[] }[] = [];
    const client = { query: async (sql: string, values?: unknown[]) => { calls.push({ sql, values: values ?? [] });
      return { rowCount: 2, rows: [
        { user_id: userId, display_name: "Atendente", role: "ATTENDANT", status: "ACTIVE", version: 3,
          allowed_actions: ["REVOKE"] },
        { user_id: invitationId, display_name: "Supervisor", role: "SUPERVISOR", status: "REVOKED", version: 4,
          allowed_actions: ["REACTIVATE"] },
      ] }; } };
    const page = await listUnitMembershipCatalog(client, { unitId, limit: 1 });
    assert.deepEqual(page.items, [{ userId, displayName: "Atendente", role: "ATTENDANT", status: "ACTIVE",
      version: 3, allowedActions: ["REVOKE"] }]);
    assert.equal("email" in page.items[0]!, false); assert.ok(page.nextCursor);
    assert.match(calls[0]!.sql, /admin_list_unit_memberships\(\$1,\$2,\$3,\$4\)/);
    assert.deepEqual(calls[0]!.values, [unitId, null, null, 2]);
    await listUnitMembershipCatalog(client, { unitId, limit: 1, cursor: page.nextCursor });
    assert.deepEqual(calls[1]!.values, [unitId, "Atendente", userId, 2]);
  });

  it("vincula cursor do catálogo à unidade e rejeita formato não canônico antes do SQL", async () => {
    let calls = 0; const client = { query: async () => { calls += 1; return { rows: [] }; } };
    const valid = Buffer.from(JSON.stringify({ v: 1, unitId, displayName: "A", id: userId })).toString("base64url");
    const otherUnit = "30000000-0000-4000-8000-000000000002";
    await assert.rejects(listUnitMembershipCatalog(client, { unitId: otherUnit, cursor: valid }), /INVALID_PAGE_CURSOR/);
    const extra = Buffer.from(JSON.stringify({ v: 1, unitId, displayName: "A", id: userId, email: "x" })).toString("base64url");
    await assert.rejects(listUnitMembershipCatalog(client, { unitId, cursor: extra }), /INVALID_PAGE_CURSOR/);
    assert.equal(calls, 0);
  });

  it("alinha o fingerprint de membership ao texto canônico jsonb da migration 0034", () => {
    const canonical = `{"reason": "risco \\"operacional\\"", "unitId": "${unitId}", "userId": "${userId}", "operation": "REVOKE", "expectedVersion": 7}`;
    assert.deepEqual(unitMembershipFingerprint({ userId, unitId, expectedVersion: 7,
      operation: "REVOKE", reason: 'risco "operacional"' }),
    createHash("sha256").update(canonical).digest());
  });

  it("normaliza lifecycle, envia todos os campos e preserva replay do SQL", async () => {
    let statement = ""; let values: readonly unknown[] = [];
    const client = { query: async (sql: string, parameters?: unknown[]) => {
      statement = sql; values = parameters ?? [];
      return { rowCount: 1, rows: [{ user_id: userId, unit_id: unitId, status: "REVOKED",
        version: 8, replayed: true }] };
    } };
    const result = await changeUnitMembership(client, { idempotencyKey: " membership-command ",
      userId: userId.toUpperCase(), unitId: unitId.toUpperCase(), expectedVersion: 7,
      operation: "REVOKE", reason: " risco operacional " });
    assert.match(statement, /admin_change_unit_membership\(\$1,\$2,\$3,\$4,\$5,\$6,\$7\)/);
    assert.deepEqual(result, { userId, unitId, status: "REVOKED", version: 8, replayed: true });
    assert.equal(values[0], "membership-command");
    assert.ok(Buffer.isBuffer(values[1]) && (values[1] as Buffer).length === 32);
    assert.deepEqual(values.slice(2), [userId, unitId, 7, "REVOKE", "risco operacional"]);
  });

  it("rejeita lifecycle inválido antes de acessar o banco", async () => {
    let calls = 0;
    const client = { query: async () => { calls += 1; return { rowCount: 0, rows: [] }; } };
    await assert.rejects(changeUnitMembership(client, { idempotencyKey: "membership-command", userId,
      unitId, expectedVersion: 0, operation: "REVOKE", reason: "risco operacional" }),
    /INVALID_MEMBERSHIP_VERSION/);
    await assert.rejects(changeUnitMembership(client, { idempotencyKey: "membership-command", userId,
      unitId, expectedVersion: 1, operation: "DELETE" as "REVOKE", reason: "risco operacional" }),
    /INVALID_MEMBERSHIP_OPERATION/);
    assert.equal(calls, 0);
  });
});
