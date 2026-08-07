import { createHash } from "node:crypto";
import { withVerifiedOidcBootstrapTransaction, type TenantTransactionPool,
  type VerifiedOidcPrincipal } from "../database/tenant-transaction.js";

export interface InvitationAcceptanceRateLimit {
  readonly allowed: boolean; readonly remaining: number;
  readonly retryAfterSeconds: number; readonly resetAt: Date;
}
interface QueryResult<Row> { readonly rowCount: number | null; readonly rows: readonly Row[] }

export async function consumeInvitationAcceptanceRateLimit(
  pool: TenantTransactionPool, principal: VerifiedOidcPrincipal,
): Promise<InvitationAcceptanceRateLimit> {
  const principalKey = createHash("sha256").update(JSON.stringify({
    version: 1, issuer: principal.issuer, audience: principal.audience, subject: principal.subject,
    organizationClaim: principal.organizationClaim ?? null,
    organizationValue: principal.organizationValue ?? null,
  })).digest();
  return withVerifiedOidcBootstrapTransaction(pool, principal, async (client) => {
    const result = await client.query(`SELECT allowed,remaining,retry_after_seconds,reset_at
      FROM consume_invitation_acceptance_rate_limit($1)`, [principalKey]) as QueryResult<{
      allowed: boolean; remaining: number; retry_after_seconds: number; reset_at: Date | string;
    }>;
    if (result.rowCount !== 1 || !result.rows[0]) throw new Error("RATE_LIMIT_COMMAND_FAILED");
    const row = result.rows[0];
    return { allowed: row.allowed, remaining: row.remaining,
      retryAfterSeconds: row.retry_after_seconds, resetAt: new Date(row.reset_at) };
  });
}
