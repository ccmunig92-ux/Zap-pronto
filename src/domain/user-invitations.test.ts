import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createUserInvitation } from "./user-invitations.js";

const unitA = "10000000-0000-4000-8000-000000000001";
const unitB = "10000000-0000-4000-8000-000000000002";

describe("createUserInvitation", () => {
  it("envia somente digest ao banco e entrega token apenas na criação", async () => {
    let values: readonly unknown[] = [];
    const client = { query: async (_text: string, parameters?: unknown[]) => {
      values = parameters ?? [];
      return { rowCount: 1, rows: [{
        id: "20000000-0000-4000-8000-000000000001", email: "user@example.com", display_name: "User",
        status: "PENDING", expires_at: new Date("2030-01-01T00:00:00.000Z"), oidc_provider_code: "primary",
        assignments: [], replayed: false,
      }] };
    } };
    const result = await createUserInvitation(client, {
      email: " User@Example.com ", displayName: " User ", providerCode: "primary",
      expiresAt: new Date(Date.now() + 60_000), idempotencyKey: "request-123",
      assignments: [{ unitId: unitB, role: "ATTENDANT" }, { unitId: unitA, role: "SUPERVISOR" }],
    });
    assert.equal(typeof result.token, "string");
    assert.equal(result.token?.length, 43);
    assert.ok(Buffer.isBuffer(values[1]) && (values[1] as Buffer).length === 32);
    assert.ok(Buffer.isBuffer(values[7]) && (values[7] as Buffer).length === 32);
    assert.equal(values.includes(result.token), false);
    assert.match(String(values[8]), new RegExp(unitA + ".*" + unitB));
  });

  it("não expõe novo token em replay", async () => {
    const client = { query: async () => ({ rowCount: 1, rows: [{
      id: "20000000-0000-4000-8000-000000000001", email: "user@example.com", display_name: "User",
      status: "PENDING", expires_at: new Date(), oidc_provider_code: "primary", assignments: [], replayed: true,
    }] }) };
    const result = await createUserInvitation(client, {
      email: "user@example.com", displayName: "User", providerCode: "primary",
      expiresAt: new Date(Date.now() + 60_000), idempotencyKey: "request-123",
      assignments: [{ unitId: unitA, role: "ATTENDANT" }],
    });
    assert.equal(result.token, undefined);
  });
});
