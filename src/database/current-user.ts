import type { TenantQueryClient } from "./tenant-transaction.js";
import type { AppRole, CurrentUser, Permission } from "@zap-pronto/contracts";

interface Rows<T> { readonly rows: T[] }
function rows<T>(value: unknown): T[] {
  if (typeof value !== "object" || value === null || !Array.isArray((value as Rows<T>).rows)) {
    throw new Error("INVALID_DATABASE_RESULT");
  }
  return (value as Rows<T>).rows;
}

export class AccountNotAssignedError extends Error {
  readonly statusCode = 403;
  readonly code = "ACCOUNT_NOT_ASSIGNED";
  constructor() { super("Account has no active unit assignment"); this.name = "AccountNotAssignedError"; }
}

export async function getCurrentUser(client: TenantQueryClient): Promise<CurrentUser> {
  const profileRows = rows<{ user_id: string; email: string; display_name: string; tenant_id: string; tenant_name: string }>(
    await client.query(`SELECT account.id AS user_id, account.email, account.display_name,
      tenant.id AS tenant_id, tenant.name AS tenant_name
      FROM users account JOIN tenants tenant ON tenant.id=account.tenant_id
      WHERE account.tenant_id=current_app_tenant_id() AND account.id=current_app_actor_id()
        AND account.status='ACTIVE' AND tenant.status='ACTIVE'`),
  );
  if (profileRows.length !== 1 || !profileRows[0]) throw new Error("AUTH_UNAUTHORIZED");

  const membershipRows = rows<{ unit_id: string; unit_code: string; unit_name: string; role: AppRole }>(
    await client.query(`SELECT unit.id AS unit_id, unit.code AS unit_code, unit.name AS unit_name, membership.role
      FROM user_units membership JOIN units unit
        ON unit.tenant_id=membership.tenant_id AND unit.id=membership.unit_id
      WHERE membership.tenant_id=current_app_tenant_id() AND membership.user_id=current_app_actor_id()
        AND unit.active=true
      ORDER BY unit.code, unit.id`),
  );
  if (membershipRows.length === 0) throw new AccountNotAssignedError();

  const grantRows = rows<{ permission: Permission; scope: "TENANT" | "UNIT"; unit_id: string | null }>(
    await client.query(`SELECT DISTINCT role_permission.permission_code AS permission,
        CASE WHEN membership.role='TENANT_ADMIN' THEN 'TENANT' ELSE 'UNIT' END AS scope,
        CASE WHEN membership.role='TENANT_ADMIN' THEN NULL ELSE membership.unit_id END AS unit_id
      FROM user_units membership
      JOIN units unit ON unit.tenant_id=membership.tenant_id AND unit.id=membership.unit_id AND unit.active=true
      JOIN app_role_permissions role_permission ON role_permission.role_code=membership.role
      WHERE membership.tenant_id=current_app_tenant_id() AND membership.user_id=current_app_actor_id()
      ORDER BY permission, scope, unit_id NULLS FIRST`),
  );
  const profile = profileRows[0];
  return {
    user: { id: profile.user_id, email: profile.email, displayName: profile.display_name },
    tenant: { id: profile.tenant_id, name: profile.tenant_name },
    memberships: membershipRows.map((row) => ({
      unitId: row.unit_id, unitCode: row.unit_code, unitName: row.unit_name, role: row.role,
    })),
    grants: grantRows.map((row) => {
      if (row.scope === "TENANT" && row.unit_id === null) {
        return { permission: row.permission, scope: "TENANT" as const };
      }
      if (row.scope === "UNIT" && row.unit_id) {
        return { permission: row.permission, scope: "UNIT" as const, unitId: row.unit_id };
      }
      throw new Error("INVALID_PERMISSION_SCOPE");
    }),
  };
}
