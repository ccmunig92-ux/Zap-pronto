import type { TenantQueryClient } from "../database/tenant-transaction.js";

export type HandoffStatus = "REQUESTED" | "QUEUED" | "ACTIVE" | "RESOLVED" | "FAILED" | "CANCELLED";

interface QueryResult<Row> {
  readonly rowCount: number | null;
  readonly rows: readonly Row[];
}

interface ServiceCaseRow {
  readonly conversation_id: string;
  readonly unit_id: string;
  readonly status: string;
  readonly version: number;
}

export interface RequestHandoffInput {
  readonly serviceCaseId: string;
  readonly expectedCaseVersion: number;
  readonly reason: string;
  readonly priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  readonly idempotencyKey: string;
  readonly slaDueAt?: Date;
}

export interface ClaimHandoffInput {
  readonly handoffId: string;
  readonly expectedVersion: number;
}

export interface IdempotentClaimHandoffInput extends ClaimHandoffInput {
  readonly idempotencyKey: string;
}

export interface HandoffQueueCursor {
  readonly priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  readonly queuedAt: Date;
  readonly id: string;
}

export interface ListQueuedHandoffsInput {
  readonly unitId: string;
  readonly limit: number;
  readonly cursor?: HandoffQueueCursor;
}

export interface QueuedHandoff extends HandoffResult {
  readonly unitId: string;
  readonly priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  readonly queuedAt: Date;
  readonly slaDueAt: Date | null;
  readonly automationStatus: string;
}

export interface HandoffResult {
  readonly id: string;
  readonly conversationId: string;
  readonly serviceCaseId: string;
  readonly status: HandoffStatus;
  readonly version: number;
}

async function query<Row>(client: TenantQueryClient, text: string, values: unknown[]): Promise<QueryResult<Row>> {
  return await client.query(text, values) as QueryResult<Row>;
}

function requiredText(value: string, code: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) throw new Error(code);
  return normalized;
}

/**
 * Suspende o Hermes, move o caso para a fila humana, registra histórico e
 * publica o evento na mesma transação aberta por withTenantTransaction.
 */
export async function requestHandoff(
  client: TenantQueryClient,
  input: RequestHandoffInput,
): Promise<HandoffResult> {
  if (!Number.isInteger(input.expectedCaseVersion) || input.expectedCaseVersion < 1) {
    throw new Error("INVALID_EXPECTED_VERSION");
  }
  const reason = requiredText(input.reason, "INVALID_HANDOFF_REASON", 200);
  const idempotencyKey = requiredText(input.idempotencyKey, "INVALID_IDEMPOTENCY_KEY", 200);

  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended(current_app_tenant_id()::text || ':handoff-case:' || $1, 0))",
    [input.serviceCaseId],
  );

  const existing = await query<HandoffResult & { conversationId: string; serviceCaseId: string }>(client, `
    SELECT id, conversation_id AS "conversationId", service_case_id AS "serviceCaseId", status, version
    FROM human_handoffs WHERE idempotency_key = $1
  `, [idempotencyKey]);
  if (existing.rowCount === 1) {
    if (existing.rows[0]!.serviceCaseId !== input.serviceCaseId) {
      throw new Error("IDEMPOTENCY_KEY_REUSED");
    }
    return existing.rows[0]!;
  }

  const serviceCase = await query<ServiceCaseRow>(client, `
    SELECT conversation_id, unit_id, status, version
    FROM service_cases WHERE id = $1 FOR UPDATE
  `, [input.serviceCaseId]);
  if (serviceCase.rowCount !== 1) throw new Error("SERVICE_CASE_NOT_FOUND");
  const current = serviceCase.rows[0]!;
  if (current.version !== input.expectedCaseVersion) throw new Error("CONCURRENT_MODIFICATION");
  if (current.status !== "COLLECTING" && current.status !== "READY_FOR_HANDOFF") {
    throw new Error("INVALID_SERVICE_CASE_TRANSITION");
  }

  const conversation = await query<{ version: number; automation_status: string }>(client, `
    SELECT version, automation_status FROM conversations
    WHERE id = $1 AND unit_id = $2 FOR UPDATE
  `, [current.conversation_id, current.unit_id]);
  if (conversation.rowCount !== 1) throw new Error("CONVERSATION_ROUTING_MISMATCH");

  const created = await query<{ id: string; version: number }>(client, `
    INSERT INTO human_handoffs
      (tenant_id, conversation_id, service_case_id, unit_id, reason, priority,
       status, queued_at, sla_due_at, idempotency_key)
    VALUES (current_app_tenant_id(), $1, $2, $3, $4, $5, 'QUEUED', now(), $6, $7)
    RETURNING id, version
  `, [current.conversation_id, input.serviceCaseId, current.unit_id, reason, input.priority,
    input.slaDueAt ?? null, idempotencyKey]);
  const handoff = created.rows[0]!;

  const waitingCase = await query<{ version: number }>(client, `
    UPDATE service_cases SET status = 'WAITING_HUMAN', version = version + 1,
      state_changed_at = now()
    WHERE id = $1 AND version = $2 AND status IN ('COLLECTING', 'READY_FOR_HANDOFF')
    RETURNING version
  `, [input.serviceCaseId, input.expectedCaseVersion]);
  if (waitingCase.rowCount !== 1) throw new Error("CONCURRENT_MODIFICATION");
  const requestedConversation = await query<{ version: number }>(client, `
    UPDATE conversations SET automation_status = 'HUMAN_REQUESTED', assigned_user_id = NULL,
      version = version + 1, state_changed_at = now(), updated_at = now()
    WHERE id = $1 AND automation_status = 'ACTIVE'
    RETURNING version
  `, [current.conversation_id]);
  if (requestedConversation.rowCount !== 1) throw new Error("CONVERSATION_NOT_AUTOMATABLE");
  const queuedConversation = await query<{ version: number }>(client, `
    UPDATE conversations SET automation_status = 'HUMAN_QUEUED', version = version + 1,
      state_changed_at = now(), updated_at = now()
    WHERE id = $1 AND automation_status = 'HUMAN_REQUESTED'
    RETURNING version
  `, [current.conversation_id]);
  if (queuedConversation.rowCount !== 1) throw new Error("CONCURRENT_MODIFICATION");
  await client.query(`
    INSERT INTO workflow_transitions
      (tenant_id, aggregate_type, aggregate_id, from_status, to_status, reason,
       actor_id, correlation_id, metadata)
    VALUES
      (current_app_tenant_id(), 'SERVICE_CASE', $1, $2, 'WAITING_HUMAN', $3,
        current_app_actor_id(), current_setting('app.correlation_id'), '{}'),
      (current_app_tenant_id(), 'HANDOFF', $4, NULL, 'QUEUED', $3,
        current_app_actor_id(), current_setting('app.correlation_id'), '{}'),
      (current_app_tenant_id(), 'CONVERSATION', $5, 'ACTIVE', 'HUMAN_REQUESTED', $3,
        current_app_actor_id(), current_setting('app.correlation_id'), '{}'),
      (current_app_tenant_id(), 'CONVERSATION', $5, 'HUMAN_REQUESTED', 'HUMAN_QUEUED', $3,
        current_app_actor_id(), current_setting('app.correlation_id'), '{}')
  `, [input.serviceCaseId, current.status, reason, handoff.id, current.conversation_id]);
  await client.query(`
    INSERT INTO outbox_events
      (tenant_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key)
    VALUES (current_app_tenant_id(), 'handoff', $1, 'handoff.queued',
      jsonb_build_object('handoffId', $1::uuid, 'conversationId', $2::uuid, 'serviceCaseId', $3::uuid), $4::text)
  `, [handoff.id, current.conversation_id, input.serviceCaseId, `handoff.queued:${handoff.id}`]);

  return {
    id: handoff.id,
    conversationId: current.conversation_id,
    serviceCaseId: input.serviceCaseId,
    status: "QUEUED",
    version: handoff.version,
  };
}

/** Claim otimista: apenas uma atualização com a versão esperada pode vencer. */
export async function claimHandoff(
  client: TenantQueryClient,
  input: ClaimHandoffInput,
): Promise<HandoffResult> {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new Error("INVALID_EXPECTED_VERSION");
  }
  const aggregate = await query<{
    id: string; conversation_id: string; service_case_id: string; version: number;
    handoff_status: string; case_status: string; case_version: number; automation_status: string;
  }>(client, `
    SELECT h.id, h.conversation_id, h.service_case_id, h.version,
      h.status AS handoff_status, sc.status AS case_status, sc.version AS case_version,
      c.automation_status
    FROM human_handoffs h
    JOIN service_cases sc ON sc.tenant_id = h.tenant_id AND sc.id = h.service_case_id
    JOIN conversations c ON c.tenant_id = h.tenant_id AND c.id = h.conversation_id
    WHERE h.id = $1
    FOR UPDATE OF h, sc, c
  `, [input.handoffId]);
  if (aggregate.rowCount !== 1) throw new Error("HANDOFF_NOT_FOUND");
  const current = aggregate.rows[0]!;
  if (current.version !== input.expectedVersion || current.handoff_status !== "QUEUED") {
    throw new Error("HANDOFF_CLAIM_CONFLICT");
  }
  if (current.case_status !== "WAITING_HUMAN" || current.automation_status !== "HUMAN_QUEUED") {
    throw new Error("HANDOFF_AGGREGATE_INCONSISTENT");
  }

  const claimed = await query<{ version: number }>(client, `
    UPDATE human_handoffs SET status = 'ACTIVE', assigned_user_id = current_app_actor_id(),
      claimed_at = now(), state_changed_at = now(), version = version + 1
    WHERE id = $1 AND version = $2 AND status = 'QUEUED'
    RETURNING version
  `, [input.handoffId, input.expectedVersion]);
  if (claimed.rowCount !== 1) throw new Error("HANDOFF_CLAIM_CONFLICT");
  const claimedVersion = claimed.rows[0]!.version;

  const reviewedCase = await query<{ version: number }>(client, `
    UPDATE service_cases SET status = 'IN_REVIEW', version = version + 1, state_changed_at = now()
    WHERE id = $1 AND version = $2 AND status = 'WAITING_HUMAN'
    RETURNING version
  `, [current.service_case_id, current.case_version]);
  if (reviewedCase.rowCount !== 1) throw new Error("HANDOFF_CLAIM_CONFLICT");

  const activeConversation = await query<{ version: number }>(client, `
    UPDATE conversations SET automation_status = 'HUMAN_ACTIVE', assigned_user_id = current_app_actor_id(),
      version = version + 1, state_changed_at = now(), updated_at = now()
    WHERE id = $1 AND automation_status = 'HUMAN_QUEUED'
    RETURNING version
  `, [current.conversation_id]);
  if (activeConversation.rowCount !== 1) throw new Error("HANDOFF_CLAIM_CONFLICT");
  await client.query(`
    INSERT INTO workflow_transitions
      (tenant_id, aggregate_type, aggregate_id, from_status, to_status, reason,
       actor_id, correlation_id, metadata)
    VALUES (current_app_tenant_id(), 'HANDOFF', $1, 'QUEUED', 'ACTIVE',
      'ATTENDANT_CLAIM', current_app_actor_id(), current_setting('app.correlation_id'), '{}'),
      (current_app_tenant_id(), 'SERVICE_CASE', $2, 'WAITING_HUMAN', 'IN_REVIEW',
        'ATTENDANT_CLAIM', current_app_actor_id(), current_setting('app.correlation_id'), '{}'),
      (current_app_tenant_id(), 'CONVERSATION', $3, 'HUMAN_QUEUED', 'HUMAN_ACTIVE',
        'ATTENDANT_CLAIM', current_app_actor_id(), current_setting('app.correlation_id'), '{}')
  `, [current.id, current.service_case_id, current.conversation_id]);
  await client.query(`
    INSERT INTO outbox_events
      (tenant_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key)
    VALUES (current_app_tenant_id(), 'handoff', $1, 'handoff.claimed',
      jsonb_build_object('handoffId', $1::uuid, 'actorId', current_app_actor_id()), $2::text)
  `, [current.id, `handoff.claimed:${current.id}`]);
  await client.query(`
    INSERT INTO audit_events (tenant_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
    VALUES (current_app_tenant_id(),'USER',current_app_actor_id()::text,'HANDOFF_CLAIMED','handoff',$1::text,
      jsonb_build_object('correlationId',current_setting('app.correlation_id'),'version',$2::integer))
  `, [current.id, claimedVersion]);

  return {
    id: current.id,
    conversationId: current.conversation_id,
    serviceCaseId: current.service_case_id,
    status: "ACTIVE",
    version: claimedVersion,
  };
}

/** Projeção interna da fila; a autorização por unidade é revalidada pela função SQL estreita. */
export async function listQueuedHandoffs(
  client: TenantQueryClient,
  input: ListQueuedHandoffsInput,
): Promise<readonly QueuedHandoff[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error("INVALID_QUEUE_LIMIT");
  const cursor = input.cursor;
  const result = await query<{
    id: string; conversation_id: string; service_case_id: string; unit_id: string;
    priority: QueuedHandoff["priority"]; queued_at: Date; sla_due_at: Date | null;
    status: HandoffStatus; version: number; automation_status: string;
  }>(client, "SELECT * FROM list_queued_handoffs($1,$2,$3,$4,$5)", [input.unitId,input.limit,
    cursor?.priority ?? null,cursor?.queuedAt ?? null,cursor?.id ?? null]);
  return result.rows.map((row) => ({ id: row.id,conversationId: row.conversation_id,
    serviceCaseId: row.service_case_id,unitId: row.unit_id,priority: row.priority,queuedAt: row.queued_at,
    slaDueAt: row.sla_due_at,status: row.status,version: row.version,automationStatus: row.automation_status }));
}

/** Replay idempotente não executa novamente transições, auditoria ou outbox. */
export async function claimHandoffIdempotent(
  client: TenantQueryClient,
  input: IdempotentClaimHandoffInput,
): Promise<HandoffResult> {
  const idempotencyKey = requiredText(input.idempotencyKey,"INVALID_IDEMPOTENCY_KEY",200);
  const replay = await query<{ result: HandoffResult | null }>(client,
    "SELECT get_handoff_claim_replay($1,$2,$3) AS result",
    [idempotencyKey,input.handoffId,input.expectedVersion]);
  if (replay.rows[0]?.result) return replay.rows[0].result;
  const claimed = await claimHandoff(client,input);
  await client.query("SELECT store_handoff_claim_result($1,$2,$3,$4::jsonb)",
    [idempotencyKey,input.handoffId,input.expectedVersion,JSON.stringify(claimed)]);
  return claimed;
}
