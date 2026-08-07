const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface VerifiedRequestContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly correlationId: string;
}

export interface VerifiedOidcPrincipal {
  readonly issuer: string;
  readonly audience: string;
  readonly subject: string;
  readonly organizationClaim?: string;
  readonly organizationValue?: string;
  readonly correlationId: string;
}

export interface TenantQueryClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export interface TenantTransactionConnection extends TenantQueryClient {
  release(error?: Error | boolean): void;
}

export interface TenantTransactionPool {
  connect(): Promise<TenantTransactionConnection>;
}

function assertContext(context: VerifiedRequestContext): void {
  if (!UUID_PATTERN.test(context.tenantId)) throw new Error("INVALID_TENANT_ID");
  if (!UUID_PATTERN.test(context.actorId)) throw new Error("INVALID_ACTOR_ID");
  if (context.correlationId.length < 8 || context.correlationId.length > 128) {
    throw new Error("INVALID_CORRELATION_ID");
  }
}

function assertOidcPrincipal(principal: VerifiedOidcPrincipal): void {
  if (!principal.issuer || !principal.audience || !principal.subject) {
    throw new Error("INVALID_OIDC_PRINCIPAL");
  }
  if ((principal.organizationClaim === undefined) !== (principal.organizationValue === undefined)) {
    throw new Error("INVALID_OIDC_ORGANIZATION");
  }
  if (principal.correlationId.length < 8 || principal.correlationId.length > 128) {
    throw new Error("INVALID_CORRELATION_ID");
  }
}

interface QueryRows<T> {
  readonly rows: T[];
}

function hasRows<T>(result: unknown): result is QueryRows<T> {
  return typeof result === "object" && result !== null && Array.isArray((result as QueryRows<T>).rows);
}

async function installContext(
  client: TenantQueryClient,
  context: VerifiedRequestContext,
): Promise<void> {
  await client.query(
    `SELECT
       set_config('app.tenant_id', $1, true),
       set_config('app.actor_id', $2, true),
       set_config('app.correlation_id', $3, true)`,
    [context.tenantId, context.actorId, context.correlationId],
  );
  await client.query("SELECT assert_app_context_authorized()");
}

async function executeTransaction<T>(
  pool: TenantTransactionPool,
  prepare: (client: TenantQueryClient) => Promise<void>,
  operation: (client: TenantQueryClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE zap_pronto_api");
    await prepare(client);
    const result = await operation(client);
    await client.query("COMMIT");
    client.release();
    return result;
  } catch (error) {
    let rollbackError: Error | undefined;
    try {
      await client.query("ROLLBACK");
    } catch (failure) {
      rollbackError = failure instanceof Error ? failure : new Error("ROLLBACK_FAILED");
    }
    if (rollbackError) client.release(rollbackError);
    else client.release();
    throw error;
  }
}

/**
 * Executa um caso de uso no escopo RLS. O contexto deve vir do middleware de
 * autenticação, nunca de campos enviados pelo cliente.
 */
export async function withTenantTransaction<T>(
  pool: TenantTransactionPool,
  context: VerifiedRequestContext,
  operation: (client: TenantQueryClient) => Promise<T>,
): Promise<T> {
  assertContext(context);
  return executeTransaction(pool, (client) => installContext(client, context), operation);
}

/**
 * Resolve a identidade OIDC e executa o caso de uso no mesmo escopo
 * transacional/RLS. Tenant e ator são derivados exclusivamente do banco.
 */
export async function withAuthenticatedTenantTransaction<T>(
  pool: TenantTransactionPool,
  principal: VerifiedOidcPrincipal,
  operation: (client: TenantQueryClient) => Promise<T>,
): Promise<T> {
  assertOidcPrincipal(principal);

  return executeTransaction(
    pool,
    async (client) => {
      const resolved = await client.query(
        `SELECT tenant_id, user_id
           FROM resolve_oidc_principal($1, $2, $3, $4, $5)`,
        [
          principal.issuer,
          principal.audience,
          principal.subject,
          principal.organizationClaim ?? null,
          principal.organizationValue ?? null,
        ],
      );

      if (!hasRows<{ tenant_id: unknown; user_id: unknown }>(resolved) || resolved.rows.length !== 1) {
        throw new Error("AUTH_UNAUTHORIZED");
      }

      const row = resolved.rows[0];
      if (!row || typeof row.tenant_id !== "string" || typeof row.user_id !== "string") {
        throw new Error("AUTH_UNAUTHORIZED");
      }

      const context = {
        tenantId: row.tenant_id,
        actorId: row.user_id,
        correlationId: principal.correlationId,
      };
      assertContext(context);
      await installContext(client, context);
    },
    operation,
  );
}

/**
 * Executa o bootstrap de uma identidade OIDC ainda não provisionada. Não instala
 * tenant nem ator: a função SQL estreita deve derivá-los da identidade verificada
 * e do convite, dentro da mesma transação.
 */
export async function withVerifiedOidcBootstrapTransaction<T>(
  pool: TenantTransactionPool,
  principal: VerifiedOidcPrincipal,
  operation: (client: TenantQueryClient) => Promise<T>,
): Promise<T> {
  assertOidcPrincipal(principal);
  return executeTransaction(
    pool,
    async (client) => {
      await client.query("SELECT set_config('app.correlation_id', $1, true)", [principal.correlationId]);
    },
    operation,
  );
}
