import type { TenantQueryClient } from "../database/tenant-transaction.js";

export type HandoffStatus = "REQUESTED" | "QUEUED" | "ACTIVE" | "RESOLVED" | "FAILED" | "CANCELLED";
type Priority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
interface QueryResult<Row> { readonly rowCount: number | null; readonly rows: readonly Row[] }

export interface RequestHandoffInput {
  readonly serviceCaseId: string; readonly expectedCaseVersion: number; readonly reason: string;
  readonly priority: Priority; readonly idempotencyKey: string; readonly slaDueAt?: Date;
}
export interface ClaimHandoffInput { readonly handoffId: string; readonly expectedVersion: number }
export interface IdempotentClaimHandoffInput extends ClaimHandoffInput { readonly idempotencyKey: string }
export interface HandoffResult {
  readonly id: string; readonly conversationId: string; readonly serviceCaseId: string;
  readonly status: HandoffStatus; readonly version: number;
}
export interface HandoffQueueCursor { readonly priority: Priority; readonly queuedAt: Date; readonly id: string }
export interface ListQueuedHandoffsInput {
  readonly unitId: string; readonly limit: number; readonly cursor?: HandoffQueueCursor;
}
export interface QueuedHandoff extends HandoffResult {
  readonly unitId: string; readonly priority: Priority; readonly queuedAt: Date;
  readonly slaDueAt: Date | null; readonly automationStatus: string;
}

async function query<Row>(client: TenantQueryClient, text: string, values: unknown[]): Promise<QueryResult<Row>> {
  return await client.query(text, values) as QueryResult<Row>;
}
function requiredText(value: string, code: string, maxLength: number, minLength = 1): string {
  const normalized = value.trim();
  if (normalized.length < minLength || normalized.length > maxLength) throw new Error(code);
  return normalized;
}
function expectedVersion(value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new Error("INVALID_EXPECTED_VERSION");
}

/** Executa o comando inteiro dentro da transação/RLS corrente; nenhum DML operacional é feito pelo cliente. */
export async function requestHandoff(client: TenantQueryClient,input: RequestHandoffInput): Promise<HandoffResult> {
  expectedVersion(input.expectedCaseVersion);
  const reason=requiredText(input.reason,"INVALID_HANDOFF_REASON",200);
  const idempotencyKey=requiredText(input.idempotencyKey,"INVALID_IDEMPOTENCY_KEY",200,8);
  const command=await query<{ result: HandoffResult }>(client,
    "SELECT request_handoff_command($1,$2,$3,$4,$5,$6) AS result",
    [input.serviceCaseId,input.expectedCaseVersion,reason,input.priority,idempotencyKey,input.slaDueAt ?? null]);
  return command.rows[0]!.result;
}

/** Compatibilidade interna: usa chave determinística; novos consumidores devem fornecer Idempotency-Key. */
export async function claimHandoff(client: TenantQueryClient,input: ClaimHandoffInput): Promise<HandoffResult> {
  expectedVersion(input.expectedVersion);
  return claimHandoffIdempotent(client,{...input,
    idempotencyKey:`legacy-claim:${input.handoffId}:${input.expectedVersion}`});
}

export async function claimHandoffIdempotent(
  client: TenantQueryClient,input: IdempotentClaimHandoffInput,
): Promise<HandoffResult> {
  expectedVersion(input.expectedVersion);
  const idempotencyKey=requiredText(input.idempotencyKey,"INVALID_IDEMPOTENCY_KEY",200,8);
  const command=await query<{ result: HandoffResult }>(client,
    "SELECT claim_handoff_command($1,$2,$3) AS result",
    [input.handoffId,input.expectedVersion,idempotencyKey]);
  return command.rows[0]!.result;
}

export async function listQueuedHandoffs(
  client: TenantQueryClient,input: ListQueuedHandoffsInput,
): Promise<readonly QueuedHandoff[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error("INVALID_QUEUE_LIMIT");
  const cursor=input.cursor;
  const result=await query<{
    id:string; conversation_id:string; service_case_id:string; unit_id:string; priority:Priority;
    queued_at:Date; sla_due_at:Date|null; status:HandoffStatus; version:number; automation_status:string;
  }>(client,"SELECT * FROM list_queued_handoffs($1,$2,$3,$4,$5)",
  [input.unitId,input.limit,cursor?.priority ?? null,cursor?.queuedAt ?? null,cursor?.id ?? null]);
  return result.rows.map((row)=>({id:row.id,conversationId:row.conversation_id,
    serviceCaseId:row.service_case_id,unitId:row.unit_id,priority:row.priority,queuedAt:row.queued_at,
    slaDueAt:row.sla_due_at,status:row.status,version:row.version,automationStatus:row.automation_status}));
}
