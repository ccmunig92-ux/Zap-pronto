import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { TenantQueryClient } from "../database/tenant-transaction.js";

export type InvitationUnitRole = "UNIT_MANAGER" | "SUPERVISOR" | "ATTENDANT" | "AUDITOR";

export interface InvitationAssignmentInput {
  readonly unitId: string;
  readonly role: InvitationUnitRole;
}

export interface CreateUserInvitationInput {
  readonly email: string;
  readonly displayName: string;
  readonly providerCode: string;
  readonly expiresAt: Date;
  readonly assignments: readonly InvitationAssignmentInput[];
  readonly idempotencyKey: string;
}

export interface UserInvitationResult {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
  readonly expiresAt: Date;
  readonly providerCode: string;
  readonly assignments: readonly {
    readonly unitId: string;
    readonly unitCode: string;
    readonly unitName: string;
    readonly role: InvitationUnitRole;
  }[];
  readonly replayed: boolean;
  /** Disponível uma única vez, apenas na criação inicial. */
  readonly token?: string;
}

export interface UserInvitationOptions {
  readonly providers: readonly { readonly code: string }[];
  readonly units: readonly { readonly id: string; readonly code: string; readonly name: string }[];
  readonly roles: readonly InvitationUnitRole[];
}

interface InvitationRow {
  readonly id: string;
  readonly email: string;
  readonly display_name: string;
  readonly status: UserInvitationResult["status"];
  readonly expires_at: Date | string;
  readonly oidc_provider_code: string;
  readonly assignments: UserInvitationResult["assignments"];
  readonly replayed: boolean;
}

interface QueryResult<Row> {
  readonly rowCount: number | null;
  readonly rows: readonly Row[];
}

const PROVIDER_CODE = /^[a-z][a-z0-9_-]{1,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES = new Set<InvitationUnitRole>(["UNIT_MANAGER", "SUPERVISOR", "ATTENDANT", "AUDITOR"]);

function normalizeInput(input: CreateUserInvitationInput) {
  const idempotencyKey = input.idempotencyKey.trim();
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();
  const providerCode = input.providerCode.trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) throw new Error("INVALID_IDEMPOTENCY_KEY");
  if (email.length < 3 || email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error("INVALID_EMAIL");
  if (displayName.length < 1 || displayName.length > 160) throw new Error("INVALID_DISPLAY_NAME");
  if (!PROVIDER_CODE.test(providerCode)) throw new Error("INVALID_PROVIDER_CODE");
  if (!(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime())) throw new Error("INVALID_EXPIRATION");
  const remaining = input.expiresAt.getTime() - Date.now();
  if (remaining <= 0 || remaining > 30 * 24 * 60 * 60 * 1_000) throw new Error("INVALID_EXPIRATION");
  if (input.assignments.length < 1 || input.assignments.length > 50) throw new Error("INVALID_ASSIGNMENTS");
  const assignments = [...input.assignments].map(({ unitId, role }) => {
    if (!UUID.test(unitId) || !ROLES.has(role)) throw new Error("INVALID_ASSIGNMENTS");
    return { unitId: unitId.toLowerCase(), role };
  }).sort((left, right) => left.unitId.localeCompare(right.unitId) || left.role.localeCompare(right.role));
  if (new Set(assignments.map(({ unitId }) => unitId)).size !== assignments.length) throw new Error("DUPLICATE_INVITATION_UNIT");
  return { idempotencyKey, email, displayName, providerCode, expiresAt: input.expiresAt, assignments };
}

export async function createUserInvitation(
  client: TenantQueryClient,
  input: CreateUserInvitationInput,
): Promise<UserInvitationResult> {
  const normalized = normalizeInput(input);
  const tokenBytes = randomBytes(32);
  const token = tokenBytes.toString("base64url");
  const tokenDigest = createHash("sha256").update(tokenBytes).digest();
  const fingerprint = createHash("sha256").update(JSON.stringify({
    email: normalized.email,
    displayName: normalized.displayName,
    providerCode: normalized.providerCode,
    expiresAt: normalized.expiresAt.toISOString(),
    assignments: normalized.assignments,
  })).digest();
  const result = await client.query(
    `SELECT id,email,display_name,status,expires_at,oidc_provider_code,assignments,replayed
       FROM admin_create_user_invitation($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [
      normalized.idempotencyKey,
      fingerprint,
      randomUUID(),
      normalized.providerCode,
      normalized.email,
      normalized.displayName,
      normalized.expiresAt,
      tokenDigest,
      JSON.stringify(normalized.assignments),
    ],
  ) as QueryResult<InvitationRow>;
  if (result.rowCount !== 1 || !result.rows[0]) throw new Error("INVITATION_COMMAND_FAILED");
  const row = result.rows[0];
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    expiresAt: new Date(row.expires_at),
    providerCode: row.oidc_provider_code,
    assignments: row.assignments,
    replayed: row.replayed,
    ...(row.replayed ? {} : { token }),
  };
}

export async function getUserInvitationOptions(client: TenantQueryClient): Promise<UserInvitationOptions> {
  const providers = await client.query(`SELECT code FROM oidc_providers
    WHERE status='ACTIVE' ORDER BY code`) as QueryResult<{ code: string }>;
  const units = await client.query(`SELECT id,code,name FROM units
    WHERE active=true ORDER BY code,id`) as QueryResult<{ id: string; code: string; name: string }>;
  return { providers: providers.rows, units: units.rows,
    roles: ["UNIT_MANAGER", "SUPERVISOR", "ATTENDANT", "AUDITOR"] };
}
