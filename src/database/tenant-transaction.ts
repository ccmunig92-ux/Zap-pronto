const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface VerifiedRequestContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly correlationId: string;
}

export interface TenantQueryClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export interface TenantTransactionConnection extends TenantQueryClient {
  release(): void;
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
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE zap_pronto_app");
    await client.query(
      `SELECT
         set_config('app.tenant_id', $1, true),
         set_config('app.actor_id', $2, true),
         set_config('app.correlation_id', $3, true)`,
      [context.tenantId, context.actorId, context.correlationId],
    );
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
