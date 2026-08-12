import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { TenantQueryClient } from "../database/tenant-transaction.js";
import type { InvitationUnitRole } from "./user-invitations.js";

type UserStatus = "ACTIVE" | "BLOCKED" | "REVOKED";
type InvitationStatus = "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
type UserAction = "BLOCK" | "ACTIVATE" | "REVOKE";
type InvitationAction = "REVOKE" | "REISSUE";
export type UnitMembershipStatus = "ACTIVE" | "REVOKED";
export type UnitMembershipOperation = "REVOKE" | "REACTIVATE";

export interface AdministrativeUser {
  readonly id: string; readonly email: string; readonly displayName: string;
  readonly status: UserStatus; readonly version: number;
  readonly memberships: readonly { readonly unitId: string; readonly unitCode: string;
    readonly unitName: string; readonly role: "TENANT_ADMIN" | InvitationUnitRole;
    readonly status:UnitMembershipStatus;readonly version:number;
    readonly allowedActions:readonly UnitMembershipOperation[] }[];
  readonly allowedActions: readonly UserAction[];
}
export interface AdministrativeInvitation {
  readonly id: string; readonly email: string; readonly displayName: string;
  readonly status: InvitationStatus; readonly expiresAt: Date; readonly providerCode: string;
  readonly assignments: readonly { readonly unitId: string; readonly unitCode: string;
    readonly unitName: string; readonly role: InvitationUnitRole }[];
  readonly allowedActions: readonly InvitationAction[];
}
export interface Page<T> { readonly items: readonly T[]; readonly nextCursor?: string }
export interface PageInput { readonly limit?: number; readonly cursor?: string }
export interface UnitMembershipCatalogItem {
  readonly userId: string; readonly displayName: string;
  readonly role: "TENANT_ADMIN" | InvitationUnitRole;
  readonly status: UnitMembershipStatus; readonly version: number;
  readonly allowedActions: readonly UnitMembershipOperation[];
}
export interface UnitMembershipCatalogInput extends PageInput { readonly unitId: string }

interface QueryResult<Row> { readonly rowCount: number | null; readonly rows: readonly Row[] }
interface UserRow {
  id: string; email: string; display_name: string; status: UserStatus; version: number;
  memberships: AdministrativeUser["memberships"]; is_self: boolean; is_last_admin: boolean;
}
interface InvitationRow {
  id: string; email: string; display_name: string; status: InvitationStatus; expires_at: Date | string;
  provider_code?: string; oidc_provider_code?: string; assignments: AdministrativeInvitation["assignments"];
}
interface InvitationMutationRow extends InvitationRow { replayed: boolean }
interface StatusRow { user_id: string; status: UserStatus; version: number; replayed: boolean }
interface MembershipLifecycleRow {
  user_id: string; unit_id: string; status: UnitMembershipStatus; version: number; replayed: boolean;
}
interface UnitMembershipCatalogRow {
  user_id: string; display_name: string; role: UnitMembershipCatalogItem["role"];
  status: UnitMembershipStatus; version: number; allowed_actions: UnitMembershipOperation[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function pageInput(input: PageInput): { limit: number; anchorId: string | null } {
  const limit = input.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("INVALID_PAGE_LIMIT");
  if (!input.cursor) return { limit, anchorId: null };
  if (input.cursor.length > 1024) throw new Error("INVALID_PAGE_CURSOR");
  try {
    const decoded = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as unknown;
    if (typeof decoded !== "object" || decoded === null
      || (decoded as { v?: unknown }).v !== 1 || !UUID.test(String((decoded as { id?: unknown }).id ?? ""))) {
      throw new Error("INVALID_PAGE_CURSOR");
    }
    return { limit, anchorId: String((decoded as { id: unknown }).id).toLowerCase() };
  } catch {
    throw new Error("INVALID_PAGE_CURSOR");
  }
}
function cursor(id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, id }), "utf8").toString("base64url");
}
function userActions(row: UserRow): readonly UserAction[] {
  if (row.is_self || row.status === "REVOKED" || row.is_last_admin) return [];
  return row.status === "ACTIVE" ? ["BLOCK", "REVOKE"] : ["ACTIVATE", "REVOKE"];
}
function invitationActions(status: InvitationStatus): readonly InvitationAction[] {
  if (status === "ACCEPTED") return [];
  return status === "PENDING" ? ["REVOKE", "REISSUE"] : ["REISSUE"];
}
function providerCode(row: InvitationRow): string {
  const code = row.provider_code ?? row.oidc_provider_code;
  if (!code) throw new Error("INVALID_INVITATION_RESULT");
  return code;
}
function commandKey(value: string): string {
  const key = value.trim();
  if (key.length < 8 || key.length > 200) throw new Error("INVALID_IDEMPOTENCY_KEY");
  return key;
}
function reason(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 3 || normalized.length > 500) throw new Error("INVALID_LIFECYCLE_REASON");
  return normalized;
}
function uuid(value: string): string {
  if (!UUID.test(value)) throw new Error("INVALID_TARGET_ID");
  return value.toLowerCase();
}
function fingerprint(value: object): Buffer {
  return createHash("sha256").update(JSON.stringify(value)).digest();
}
const BASE64URL = /^[A-Za-z0-9_-]+$/;
function unitCatalogPage(input: UnitMembershipCatalogInput): {
  unitId: string; limit: number; anchorDisplayName: string | null; anchorUserId: string | null;
} {
  const unitId = uuid(input.unitId); const limit = input.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("INVALID_PAGE_LIMIT");
  if (!input.cursor) return { unitId, limit, anchorDisplayName: null, anchorUserId: null };
  if (input.cursor.length > 1024 || !BASE64URL.test(input.cursor)) throw new Error("INVALID_PAGE_CURSOR");
  try {
    const decoded = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (Object.keys(decoded).sort().join(",") !== "displayName,id,unitId,v" || decoded.v !== 1
      || decoded.unitId !== unitId || typeof decoded.displayName !== "string"
      || decoded.displayName.length < 1 || decoded.displayName.length > 160
      || typeof decoded.id !== "string" || !UUID.test(decoded.id)) throw new Error();
    return { unitId, limit, anchorDisplayName: decoded.displayName, anchorUserId: decoded.id.toLowerCase() };
  } catch { throw new Error("INVALID_PAGE_CURSOR"); }
}
function unitCatalogCursor(unitId: string, displayName: string, id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, unitId, displayName, id }), "utf8").toString("base64url");
}

/** Matches PostgreSQL jsonb_build_object(...)::text key ordering used by migration 0034. */
export function unitMembershipFingerprint(input: {
  readonly userId: string; readonly unitId: string; readonly expectedVersion: number;
  readonly operation: UnitMembershipOperation; readonly reason: string;
}): Buffer {
  const canonical = `{"reason": ${JSON.stringify(input.reason)}, "unitId": ${JSON.stringify(input.unitId)}, "userId": ${JSON.stringify(input.userId)}, "operation": ${JSON.stringify(input.operation)}, "expectedVersion": ${input.expectedVersion}}`;
  return createHash("sha256").update(canonical).digest();
}

export async function listAdministrativeUsers(
  client: TenantQueryClient, input: PageInput = {},
): Promise<Page<AdministrativeUser>> {
  const page = pageInput(input);
  const result = await client.query(`
    WITH admin_count AS (
      SELECT count(DISTINCT account.id)::integer AS value
      FROM users account JOIN user_units membership ON membership.user_id=account.id
      JOIN units unit ON unit.id=membership.unit_id AND unit.active=true
      WHERE account.status='ACTIVE' AND membership.role='TENANT_ADMIN' AND membership.status='ACTIVE'
    ), anchor AS (SELECT email_normalized,id FROM users WHERE id=$2::uuid)
    SELECT account.id,account.email,account.display_name,account.status,account.version,
      account.id=current_app_actor_id() AS is_self,
      (account.status='ACTIVE' AND admin_count.value=1 AND EXISTS (
        SELECT 1 FROM user_units own_membership JOIN units own_unit
          ON own_unit.id=own_membership.unit_id AND own_unit.active=true
        WHERE own_membership.user_id=account.id AND own_membership.role='TENANT_ADMIN'
          AND own_membership.status='ACTIVE'
      )) AS is_last_admin,
      COALESCE(jsonb_agg(jsonb_build_object('unitId',unit.id,'unitCode',unit.code,
        'unitName',unit.name,'role',membership.role,'status',membership.status,'version',membership.version,
        'allowedActions',CASE WHEN account.id=current_app_actor_id() OR account.status<>'ACTIVE' OR unit.active=false
          OR (membership.role='TENANT_ADMIN' AND admin_count.value=1)
          OR (membership.status='ACTIVE' AND (EXISTS(SELECT 1 FROM human_handoffs h WHERE h.tenant_id=account.tenant_id AND h.unit_id=unit.id AND h.assigned_user_id=account.id AND h.status='ACTIVE')
            OR EXISTS(SELECT 1 FROM conversations c WHERE c.tenant_id=account.tenant_id AND c.unit_id=unit.id AND c.assigned_user_id=account.id AND c.automation_status='HUMAN_ACTIVE')))
          THEN '[]'::jsonb WHEN membership.status='ACTIVE' THEN '["REVOKE"]'::jsonb ELSE '["REACTIVATE"]'::jsonb END)
        ORDER BY unit.code,unit.id)
        FILTER (WHERE unit.id IS NOT NULL),'[]'::jsonb) AS memberships
    FROM users account CROSS JOIN admin_count LEFT JOIN anchor ON true
    LEFT JOIN user_units membership ON membership.tenant_id=account.tenant_id AND membership.user_id=account.id
    LEFT JOIN units unit ON unit.tenant_id=membership.tenant_id AND unit.id=membership.unit_id
    WHERE ($2::uuid IS NULL OR (account.email_normalized,account.id)>(anchor.email_normalized,anchor.id))
    GROUP BY account.id,admin_count.value,anchor.email_normalized,anchor.id
    ORDER BY account.email_normalized,account.id LIMIT $1`, [page.limit + 1, page.anchorId]) as QueryResult<UserRow>;
  const hasNext = result.rows.length > page.limit;
  const rows = result.rows.slice(0, page.limit);
  return { items: rows.map((row) => ({ id: row.id, email: row.email, displayName: row.display_name,
    status: row.status, version: row.version, memberships: row.memberships, allowedActions: userActions(row) })),
  ...(hasNext && rows.at(-1) ? { nextCursor: cursor(rows.at(-1)!.id) } : {}) };
}

export async function listAdministrativeInvitations(
  client: TenantQueryClient, input: PageInput = {},
): Promise<Page<AdministrativeInvitation>> {
  const page = pageInput(input);
  const result = await client.query(`SELECT id,email,display_name,status,expires_at,provider_code,assignments
    FROM admin_list_user_invitations($2,$1)`, [page.limit + 1, page.anchorId]) as QueryResult<InvitationRow>;
  const hasNext = result.rows.length > page.limit;
  const rows = result.rows.slice(0, page.limit);
  return { items: rows.map((row) => ({ id: row.id, email: row.email, displayName: row.display_name,
    status: row.status, expiresAt: new Date(row.expires_at), providerCode: providerCode(row),
    assignments: row.assignments, allowedActions: invitationActions(row.status) })),
  ...(hasNext && rows.at(-1) ? { nextCursor: cursor(rows.at(-1)!.id) } : {}) };
}

export interface ChangeAdministrativeUserStatusInput {
  readonly idempotencyKey: string; readonly userId: string; readonly expectedVersion: number;
  readonly action: UserAction; readonly reason: string;
}
export async function changeAdministrativeUserStatus(
  client: TenantQueryClient, input: ChangeAdministrativeUserStatusInput,
): Promise<{ readonly id: string; readonly status: UserStatus; readonly version: number; readonly replayed: boolean }> {
  const key = commandKey(input.idempotencyKey); const userId = uuid(input.userId); const why = reason(input.reason);
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw new Error("INVALID_USER_VERSION");
  const targetStatus: UserStatus = input.action === "BLOCK" ? "BLOCKED"
    : input.action === "ACTIVATE" ? "ACTIVE" : input.action === "REVOKE" ? "REVOKED"
      : (() => { throw new Error("INVALID_USER_STATUS_ACTION"); })();
  const digest = fingerprint({ userId, expectedVersion: input.expectedVersion, targetStatus, reason: why });
  const result = await client.query(`SELECT user_id,status,version,replayed
    FROM admin_change_user_status($1,$2,$3,$4,$5,$6)`,
  [key, digest, userId, input.expectedVersion, targetStatus, why]) as QueryResult<StatusRow>;
  if (result.rowCount !== 1 || !result.rows[0]) throw new Error("USER_STATUS_COMMAND_FAILED");
  const row = result.rows[0];
  return { id: row.user_id, status: row.status, version: row.version, replayed: row.replayed };
}

export async function listUnitMembershipCatalog(
  client: TenantQueryClient, input: UnitMembershipCatalogInput,
): Promise<Page<UnitMembershipCatalogItem>> {
  const page = unitCatalogPage(input);
  const result = await client.query(`SELECT user_id,display_name,role,status,version,allowed_actions
    FROM admin_list_unit_memberships($1,$2,$3,$4)`,
  [page.unitId, page.anchorDisplayName, page.anchorUserId, page.limit + 1]) as QueryResult<UnitMembershipCatalogRow>;
  const hasNext = result.rows.length > page.limit; const rows = result.rows.slice(0, page.limit);
  return { items: rows.map((row) => ({ userId: row.user_id, displayName: row.display_name,
    role: row.role, status: row.status, version: row.version, allowedActions: row.allowed_actions })),
  ...(hasNext && rows.at(-1) ? { nextCursor: unitCatalogCursor(page.unitId,
    rows.at(-1)!.display_name, rows.at(-1)!.user_id) } : {}) };
}

export interface ChangeUnitMembershipInput {
  readonly idempotencyKey: string; readonly userId: string; readonly unitId: string;
  readonly expectedVersion: number; readonly operation: UnitMembershipOperation; readonly reason: string;
}
export interface UnitMembershipMutationResult {
  readonly userId: string; readonly unitId: string; readonly status: UnitMembershipStatus;
  readonly version: number; readonly replayed: boolean;
}
export async function changeUnitMembership(
  client: TenantQueryClient, input: ChangeUnitMembershipInput,
): Promise<UnitMembershipMutationResult> {
  const key = commandKey(input.idempotencyKey);
  const userId = uuid(input.userId);
  const unitId = uuid(input.unitId);
  const why = reason(input.reason);
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new Error("INVALID_MEMBERSHIP_VERSION");
  }
  if (input.operation !== "REVOKE" && input.operation !== "REACTIVATE") {
    throw new Error("INVALID_MEMBERSHIP_OPERATION");
  }
  const digest = unitMembershipFingerprint({ userId, unitId, expectedVersion: input.expectedVersion,
    operation: input.operation, reason: why });
  const result = await client.query(`SELECT user_id,unit_id,status,version,replayed
    FROM admin_change_unit_membership($1,$2,$3,$4,$5,$6,$7)`,
  [key, digest, userId, unitId, input.expectedVersion, input.operation, why]) as QueryResult<MembershipLifecycleRow>;
  if (result.rowCount !== 1 || !result.rows[0]) throw new Error("MEMBERSHIP_LIFECYCLE_COMMAND_FAILED");
  const row = result.rows[0];
  return { userId: row.user_id, unitId: row.unit_id, status: row.status,
    version: row.version, replayed: row.replayed };
}

export interface RevokeInvitationInput { readonly idempotencyKey: string; readonly invitationId: string; readonly reason: string }
export async function revokeUserInvitation(
  client: TenantQueryClient, input: RevokeInvitationInput,
): Promise<AdministrativeInvitation & { readonly replayed: boolean }> {
  const key = commandKey(input.idempotencyKey); const invitationId = uuid(input.invitationId); const why = reason(input.reason);
  const result = await client.query(`SELECT id,email,display_name,status,expires_at,oidc_provider_code,assignments,replayed
    FROM admin_revoke_user_invitation($1,$2,$3,$4)`,
  [key, fingerprint({ invitationId, reason: why }), invitationId, why]) as QueryResult<InvitationMutationRow>;
  if (result.rowCount !== 1 || !result.rows[0]) throw new Error("INVITATION_REVOKE_FAILED");
  const row = result.rows[0];
  return { id: row.id, email: row.email, displayName: row.display_name, status: row.status,
    expiresAt: new Date(row.expires_at), providerCode: providerCode(row),
    assignments: row.assignments, allowedActions: invitationActions(row.status), replayed: row.replayed };
}

export interface ReissueInvitationInput {
  readonly idempotencyKey: string; readonly invitationId: string; readonly expiresAt: Date; readonly reason: string;
}
export async function reissueUserInvitation(
  client: TenantQueryClient, input: ReissueInvitationInput,
): Promise<(AdministrativeInvitation & { readonly replayed: boolean; readonly token?: string })> {
  const key = commandKey(input.idempotencyKey); const invitationId = uuid(input.invitationId); const why = reason(input.reason);
  if (!(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime())) throw new Error("INVALID_EXPIRATION");
  const remaining = input.expiresAt.getTime() - Date.now();
  if (remaining <= 0 || remaining > 30 * 24 * 60 * 60 * 1_000) throw new Error("INVALID_EXPIRATION");
  const tokenBytes = randomBytes(32); const token = tokenBytes.toString("base64url");
  const tokenDigest = createHash("sha256").update(tokenBytes).digest();
  const newInvitationId = randomUUID();
  const digest = fingerprint({ invitationId, expiresAt: input.expiresAt.toISOString(), reason: why });
  const result = await client.query(`SELECT id,email,display_name,status,expires_at,oidc_provider_code,assignments,replayed
    FROM admin_reissue_user_invitation($1,$2,$3,$4,$5,$6,$7)`,
  [key, digest, invitationId, newInvitationId, input.expiresAt, tokenDigest, why]) as QueryResult<InvitationMutationRow>;
  if (result.rowCount !== 1 || !result.rows[0]) throw new Error("INVITATION_REISSUE_FAILED");
  const row = result.rows[0];
  return { id: row.id, email: row.email, displayName: row.display_name, status: row.status,
    expiresAt: new Date(row.expires_at), providerCode: providerCode(row),
    assignments: row.assignments, allowedActions: invitationActions(row.status), replayed: row.replayed,
    ...(row.replayed ? {} : { token }) };
}
