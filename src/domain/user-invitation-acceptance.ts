import { createHash, randomUUID } from "node:crypto";
import type { CurrentUser } from "@zap-pronto/contracts";
import { getCurrentUser } from "../database/current-user.js";
import type { TenantQueryClient, VerifiedOidcPrincipal } from "../database/tenant-transaction.js";

export interface AcceptUserInvitationInput {
  readonly invitationToken: string;
  readonly idempotencyKey: string;
  readonly principal: VerifiedOidcPrincipal & { readonly verifiedEmail?: string };
}
export interface AcceptUserInvitationResult { readonly currentUser: CurrentUser; readonly replayed: boolean }
interface QueryResult<Row> { readonly rowCount: number | null; readonly rows: readonly Row[] }

export async function acceptUserInvitation(
  client: TenantQueryClient, input: AcceptUserInvitationInput,
): Promise<AcceptUserInvitationResult> {
  const key = input.idempotencyKey.trim();
  if (key.length < 8 || key.length > 200) throw new Error("INVALID_IDEMPOTENCY_KEY");
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.invitationToken)) throw new Error("INVALID_INVITATION_TOKEN");
  const tokenBytes = Buffer.from(input.invitationToken, "base64url");
  if (tokenBytes.length !== 32) throw new Error("INVALID_INVITATION_TOKEN");
  const email = input.principal.verifiedEmail?.trim().toLowerCase();
  if (!email) throw new Error("VERIFIED_EMAIL_REQUIRED");
  const tokenDigest = createHash("sha256").update(tokenBytes).digest();
  const commandFingerprint = createHash("sha256").update(JSON.stringify({
    tokenDigest: tokenDigest.toString("hex"), issuer: input.principal.issuer,
    audience: input.principal.audience, subject: input.principal.subject,
    organizationClaim: input.principal.organizationClaim ?? null,
    organizationValue: input.principal.organizationValue ?? null, email,
  })).digest();
  const result = await client.query(`SELECT tenant_id,user_id,invitation_id,email,display_name,memberships,replayed
    FROM accept_user_invitation_oidc($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [
    key, commandFingerprint, tokenDigest, randomUUID(), input.principal.issuer, input.principal.audience,
    input.principal.subject, input.principal.organizationClaim ?? null,
    input.principal.organizationValue ?? null, email, true, input.principal.correlationId,
  ]) as QueryResult<{ replayed: boolean }>;
  if (result.rowCount !== 1 || !result.rows[0]) throw new Error("INVITATION_ACCEPTANCE_FAILED");
  return { currentUser: await getCurrentUser(client), replayed: result.rows[0].replayed };
}
