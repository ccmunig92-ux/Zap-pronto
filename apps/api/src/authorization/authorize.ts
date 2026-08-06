import type { TenantQueryClient } from "@zap-pronto/core/database/tenant-transaction";
import type { Permission } from "./permissions.js";

interface BooleanQueryResult { readonly rows: readonly { allowed: boolean }[] }

export class AuthorizationDeniedError extends Error {
  readonly statusCode = 403;
  readonly code = "AUTHORIZATION_DENIED";
  constructor() {
    super("Authorization denied");
    this.name = "AuthorizationDeniedError";
  }
}

export async function requirePermission(
  client: TenantQueryClient,
  permission: Permission,
  unitId?: string,
): Promise<void> {
  const result = await client.query(
    "SELECT current_actor_has_permission($1,$2::uuid) AS allowed",
    [permission, unitId ?? null],
  ) as BooleanQueryResult;
  if (result.rows.length !== 1 || result.rows[0]?.allowed !== true) {
    throw new AuthorizationDeniedError();
  }
}
