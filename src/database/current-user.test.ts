import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getCurrentUser } from "./current-user.js";

describe("current user membership lifecycle", () => {
  it("deriva memberships e grants exclusivamente de vínculos ACTIVE", async () => {
    const statements: string[] = [];
    const client = { query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes("account.id AS user_id")) return { rows: [{
        user_id: "10000000-0000-4000-8000-000000000001",
        email: "active@example.test", display_name: "Active",
        tenant_id: "20000000-0000-4000-8000-000000000001", tenant_name: "Tenant",
      }] };
      if (sql.includes("unit.id AS unit_id")) return { rows: [{
        unit_id: "30000000-0000-4000-8000-000000000001",
        unit_code: "CENTRO", unit_name: "Centro", role: "ATTENDANT",
      }] };
      if (sql.includes("role_permission.permission_code")) return { rows: [{
        permission: "handoff.read", scope: "UNIT",
        unit_id: "30000000-0000-4000-8000-000000000001",
      }] };
      throw new Error("UNEXPECTED_QUERY");
    } };

    await getCurrentUser(client);

    const membershipQuery = statements.find((sql) => sql.includes("unit.id AS unit_id"));
    const grantQuery = statements.find((sql) => sql.includes("role_permission.permission_code"));
    assert.match(membershipQuery ?? "", /membership\.status\s*=\s*'ACTIVE'/);
    assert.match(grantQuery ?? "", /membership\.status\s*=\s*'ACTIVE'/);
  });
});
