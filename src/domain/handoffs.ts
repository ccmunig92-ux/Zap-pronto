import { createHash } from "node:crypto";
import type { TenantQueryClient } from "../database/tenant-transaction.js";
import type { HandoffResolutionDisposition } from "@zap-pronto/contracts";

export type HandoffStatus = "REQUESTED" | "QUEUED" | "ACTIVE" | "RESOLVED" | "FAILED" | "CANCELLED";

const resolutionDispositions:readonly HandoffResolutionDisposition[]=["RESOLVED","DUPLICATE","CUSTOMER_WITHDREW","EXTERNAL_REFERRAL"];

export function resolveHandoffFingerprint(input:{handoffId:string;expectedVersion:number;disposition:HandoffResolutionDisposition}){
  return createHash("sha256").update(JSON.stringify({handoffId:input.handoffId.toLowerCase(),expectedVersion:input.expectedVersion,disposition:input.disposition})).digest("hex");
}

export async function resolveHandoff(client:TenantQueryClient,input:{handoffId:string;expectedVersion:number;disposition:HandoffResolutionDisposition;idempotencyKey:string}){
  const key=input.idempotencyKey.trim();if(key.length<8||key.length>200)throw new Error("INVALID_IDEMPOTENCY_KEY");
  if(!Number.isInteger(input.expectedVersion)||input.expectedVersion<1)throw new Error("INVALID_EXPECTED_VERSION");
  if(!resolutionDispositions.includes(input.disposition))throw new Error("INVALID_RESOLUTION_DISPOSITION");
  const fingerprint=resolveHandoffFingerprint(input);
  const result=await client.query(`SELECT handoff_id AS "handoffId",conversation_id AS "conversationId",service_case_id AS "serviceCaseId",
    handoff_version AS "handoffVersion",conversation_version AS "conversationVersion",replayed
    FROM resolve_inbox_handoff($1,$2,$3,$4,$5)`,[input.handoffId,input.expectedVersion,input.disposition,key,fingerprint]) as{rows:{handoffId:string;conversationId:string;serviceCaseId:string;handoffVersion:number;conversationVersion:number;replayed:boolean}[]};
  const row=result.rows[0];if(!row)throw new Error("HANDOFF_RESOLVE_NOT_FOUND");return row;
}

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
  readonly idempotencyKey: string;
}

export interface HandoffResult {
  readonly id: string;
  readonly conversationId: string;
  readonly serviceCaseId: string;
  readonly status: HandoffStatus;
  readonly version: number;
  readonly assignedUserId?: string;
  readonly automationStatus?: string;
  readonly replayed?: boolean;
}

export type HandoffSlaStatus="ON_TRACK"|"DUE_SOON"|"OVERDUE";
export interface ListHandoffsInput { readonly unitId: string; readonly limit?: number; readonly cursor?: string;
  readonly priority?:"LOW"|"NORMAL"|"HIGH"|"URGENT";readonly slaStatus?:HandoffSlaStatus;readonly now?:Date }
export interface InboxHandoff { readonly id: string; readonly conversationId: string; readonly serviceCaseId: string;
  readonly unitId: string; readonly contactName: string | null; readonly reason: string;
  readonly priority: "LOW" | "NORMAL" | "HIGH" | "URGENT"; readonly status: HandoffStatus;
  readonly assignedUserId: string | null; readonly requestedAt: Date; readonly queuedAt: Date | null;
  readonly slaDueAt: Date | null;readonly slaStatus:HandoffSlaStatus|null; readonly automationStatus: string; readonly version: number }
export interface HandoffsPage { readonly items: readonly InboxHandoff[]; readonly nextCursor?: string }
export type HandoffHistoryDisposition="LEGACY_UNSPECIFIED"|"RESOLVED"|"DUPLICATE"|"CUSTOMER_WITHDREW"|"EXTERNAL_REFERRAL";
export interface ResolvedHandoff {readonly id:string;readonly conversationId:string;readonly unitId:string;
  readonly contactName:string|null;readonly reason:string;readonly priority:"LOW"|"NORMAL"|"HIGH"|"URGENT";
  readonly resolvedAt:Date;readonly disposition:HandoffHistoryDisposition;readonly resolvedByUserId:string|null;
  readonly resolvedByDisplayName:string|null;readonly version:number;
  readonly reopenTarget:{readonly handoffId:string;readonly expectedVersion:number}|null}
export interface ResolvedHandoffsPage{readonly items:readonly ResolvedHandoff[];readonly nextCursor?:string}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
interface ListCursor{readonly v:2;readonly unitId:string;readonly priorityFilter:string|null;readonly slaStatusFilter:HandoffSlaStatus|null;readonly asOf:string;
  readonly priorityRank:number;readonly slaMissing:boolean;readonly slaDueAt:string|null;readonly queuedAt:string;readonly id:string}
interface ActiveCursor {readonly claimedAt:string;readonly id:string;readonly unitId:string}
interface SupervisedCursor {readonly v:1;readonly scope:"UNIT";readonly claimedAt:string;readonly id:string;readonly unitId:string}
interface ResolvedCursor{readonly v:2;readonly scope:"UNIT_RESOLVED";readonly unitId:string;
  readonly priorityFilter:ResolvedHandoffsInput["priority"]|null;readonly dispositionFilter:HandoffHistoryDisposition|null;
  readonly resolvedFrom:string|null;readonly resolvedBefore:string|null;readonly resolvedAt:string;readonly id:string}

export interface ResolvedHandoffsInput{readonly unitId:string;readonly limit?:number;readonly cursor?:string;
  readonly priority?:"LOW"|"NORMAL"|"HIGH"|"URGENT";readonly disposition?:HandoffHistoryDisposition;
  readonly resolvedFrom?:string;readonly resolvedBefore?:string}

const historyDispositions:readonly HandoffHistoryDisposition[]=["LEGACY_UNSPECIFIED","RESOLVED","DUPLICATE","CUSTOMER_WITHDREW","EXTERNAL_REFERRAL"];
function historyInstant(value:string|undefined):string|null{if(value===undefined)return null;const date=new Date(value);
  if(!Number.isFinite(date.getTime()))throw new Error("INVALID_HANDOFF_FILTER");return date.toISOString()}

function resolvedCursor(value:string|undefined,filters:{unitId:string;priority:ResolvedHandoffsInput["priority"]|null;
  disposition:HandoffHistoryDisposition|null;resolvedFrom:string|null;resolvedBefore:string|null}):ResolvedCursor|null{
  if(!value)return null;if(value.length>1024||!BASE64URL.test(value))throw new Error("INVALID_PAGE_CURSOR");
  try{const bytes=Buffer.from(value,"base64url");if(bytes.toString("base64url")!==value)throw new Error();
    const x=JSON.parse(bytes.toString("utf8"))as Record<string,unknown>;
    if(Object.keys(x).sort().join(",")!=="dispositionFilter,id,priorityFilter,resolvedAt,resolvedBefore,resolvedFrom,scope,unitId,v"
      ||x.v!==2||x.scope!=="UNIT_RESOLVED"||x.unitId!==filters.unitId||x.priorityFilter!==filters.priority
      ||x.dispositionFilter!==filters.disposition||x.resolvedFrom!==filters.resolvedFrom||x.resolvedBefore!==filters.resolvedBefore
      ||typeof x.id!=="string"||!UUID.test(x.id)||typeof x.resolvedAt!=="string"||!ISO_INSTANT.test(x.resolvedAt)
      ||new Date(x.resolvedAt).toISOString()!==x.resolvedAt)throw new Error();return x as unknown as ResolvedCursor;
  }catch{throw new Error("INVALID_PAGE_CURSOR")}}

export async function listResolvedHandoffs(client:TenantQueryClient,input:ResolvedHandoffsInput):Promise<ResolvedHandoffsPage>{
  if(!UUID.test(input.unitId))throw new Error("INVALID_UNIT_ID");const limit=input.limit??25;
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error("INVALID_PAGE_LIMIT");
  if(input.priority&&!(["LOW","NORMAL","HIGH","URGENT"]as const).includes(input.priority)
    ||input.disposition&&!historyDispositions.includes(input.disposition))throw new Error("INVALID_HANDOFF_FILTER");
  const resolvedFrom=historyInstant(input.resolvedFrom),resolvedBefore=historyInstant(input.resolvedBefore);
  if(resolvedFrom&&resolvedBefore){const span=new Date(resolvedBefore).getTime()-new Date(resolvedFrom).getTime();
    if(span<=0||span>366*24*60*60*1000)throw new Error("INVALID_HANDOFF_FILTER")}
  const filters={unitId:input.unitId,priority:input.priority??null,disposition:input.disposition??null,resolvedFrom,resolvedBefore};
  const anchor=resolvedCursor(input.cursor,filters);
  const result=await query<ResolvedHandoff>(client,`SELECT id,conversation_id AS "conversationId",unit_id AS "unitId",contact_name AS "contactName",
    reason,priority,resolved_at AS "resolvedAt",disposition,resolved_by_user_id AS "resolvedByUserId",
    resolved_by_display_name AS "resolvedByDisplayName",version,
    CASE WHEN reopen_handoff_id IS NULL THEN NULL ELSE jsonb_build_object('handoffId',reopen_handoff_id,'expectedVersion',reopen_expected_version) END AS "reopenTarget"
    FROM list_inbox_resolved_handoffs_v3($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz,$8::uuid)`,
    [input.unitId,limit+1,filters.priority,filters.disposition,resolvedFrom,resolvedBefore,anchor?.resolvedAt??null,anchor?.id??null]);
  const rows=result.rows.slice(0,limit),last=rows.at(-1);return{items:rows,...(result.rows.length>limit&&last?{nextCursor:Buffer.from(JSON.stringify({v:2,
    scope:"UNIT_RESOLVED",unitId:input.unitId,priorityFilter:filters.priority,dispositionFilter:filters.disposition,resolvedFrom,resolvedBefore,
    resolvedAt:new Date(last.resolvedAt).toISOString(),id:last.id})).toString("base64url")}:{})};
}

function listCursor(value:string|undefined,input:{unitId:string;priority?:string;slaStatus?:HandoffSlaStatus}):ListCursor|null{
  if (!value) return null;
  if (value.length > 1024 || !BASE64URL.test(value)) throw new Error("INVALID_PAGE_CURSOR");
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error();
    const decoded = JSON.parse(bytes.toString("utf8")) as unknown;
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) throw new Error();
    const cursor = decoded as Record<string, unknown>;
    if(Object.keys(cursor).sort().join(",")!=="asOf,id,priorityFilter,priorityRank,queuedAt,slaDueAt,slaMissing,slaStatusFilter,unitId,v"
      ||cursor.v!==2||cursor.unitId!==input.unitId||cursor.priorityFilter!==(input.priority??null)||cursor.slaStatusFilter!==(input.slaStatus??null)
      ||!Number.isInteger(cursor.priorityRank)||Number(cursor.priorityRank)<1||Number(cursor.priorityRank)>4||typeof cursor.slaMissing!=="boolean"
      ||typeof cursor.asOf!=="string"||!ISO_INSTANT.test(cursor.asOf)||new Date(cursor.asOf).toISOString()!==cursor.asOf
      ||!(cursor.slaDueAt===null||typeof cursor.slaDueAt==="string"&&ISO_INSTANT.test(cursor.slaDueAt)&&new Date(cursor.slaDueAt).toISOString()===cursor.slaDueAt)
      ||cursor.slaMissing!==(cursor.slaDueAt===null)
      || typeof cursor.queuedAt !== "string" || !ISO_INSTANT.test(cursor.queuedAt)
      || new Date(cursor.queuedAt).toISOString() !== cursor.queuedAt
      || typeof cursor.id !== "string" || !UUID.test(cursor.id)
      ||typeof cursor.unitId!=="string")throw new Error();
    return cursor as unknown as ListCursor;
  } catch { throw new Error("INVALID_PAGE_CURSOR"); }
}
export async function listHandoffs(client: TenantQueryClient, input: ListHandoffsInput): Promise<HandoffsPage> {
  if (!UUID.test(input.unitId)) throw new Error("INVALID_UNIT_ID");
  if(input.priority&&!(["LOW","NORMAL","HIGH","URGENT"]as const).includes(input.priority))throw new Error("INVALID_HANDOFF_FILTER");
  if(input.slaStatus&&!(["ON_TRACK","DUE_SOON","OVERDUE"]as const).includes(input.slaStatus))throw new Error("INVALID_HANDOFF_FILTER");
  const limit = input.limit ?? 25; if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("INVALID_PAGE_LIMIT");
  const anchor=listCursor(input.cursor,input);const suppliedNow=input.now??new Date();if(!(suppliedNow instanceof Date)||!Number.isFinite(suppliedNow.getTime()))throw new Error("INVALID_HANDOFF_CLOCK");
  const asOf=anchor?.asOf??suppliedNow.toISOString();
  if (anchor) {
    const anchorResult = await query<{ valid: boolean }>(client, `
      SELECT EXISTS (
        SELECT 1 FROM human_handoffs h
        WHERE h.id=$1::uuid AND h.unit_id=$2::uuid AND h.status='QUEUED' AND ($3::text IS NULL OR h.priority=$3)
          AND ($4::text IS NULL OR CASE WHEN h.sla_due_at IS NULL THEN NULL WHEN h.sla_due_at<=$5::timestamptz THEN 'OVERDUE'
            WHEN h.sla_due_at<=$5::timestamptz+interval '15 minutes' THEN 'DUE_SOON' ELSE 'ON_TRACK' END=$4)
          AND date_trunc('milliseconds',h.queued_at)=$6::timestamptz
          AND CASE h.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 ELSE 4 END=$7
          AND (h.sla_due_at IS NULL)=$8 AND date_trunc('milliseconds',h.sla_due_at) IS NOT DISTINCT FROM $9::timestamptz
      ) AS valid`,
      [anchor.id,anchor.unitId,anchor.priorityFilter,anchor.slaStatusFilter,anchor.asOf,anchor.queuedAt,anchor.priorityRank,anchor.slaMissing,anchor.slaDueAt]);
    if (anchorResult.rows[0]?.valid !== true) throw new Error("INVALID_PAGE_CURSOR");
  }
  const result=await query<InboxHandoff&{priorityRank:number;slaMissing:boolean}>(client,`
    SELECT h.id,h.conversation_id AS "conversationId",h.service_case_id AS "serviceCaseId",h.unit_id AS "unitId",
      contact.display_name AS "contactName",h.reason,h.priority,h.status,h.assigned_user_id AS "assignedUserId",
      h.requested_at AS "requestedAt",h.queued_at AS "queuedAt",h.sla_due_at AS "slaDueAt",
      CASE WHEN h.sla_due_at IS NULL THEN NULL WHEN h.sla_due_at<=$4::timestamptz THEN 'OVERDUE'
        WHEN h.sla_due_at<=$4::timestamptz+interval '15 minutes' THEN 'DUE_SOON' ELSE 'ON_TRACK' END AS "slaStatus",
      conversation.automation_status AS "automationStatus",h.version,
      CASE h.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 ELSE 4 END AS "priorityRank",(h.sla_due_at IS NULL) AS "slaMissing"
    FROM human_handoffs h JOIN conversations conversation ON conversation.id=h.conversation_id AND conversation.tenant_id=h.tenant_id
    JOIN contacts contact ON contact.id=conversation.contact_id AND contact.tenant_id=conversation.tenant_id
    WHERE h.unit_id=$1 AND h.status='QUEUED' AND ($2::text IS NULL OR h.priority=$2)
      AND ($3::text IS NULL OR CASE WHEN h.sla_due_at IS NULL THEN NULL WHEN h.sla_due_at<=$4::timestamptz THEN 'OVERDUE'
        WHEN h.sla_due_at<=$4::timestamptz+interval '15 minutes' THEN 'DUE_SOON' ELSE 'ON_TRACK' END=$3)
      AND ($5::integer IS NULL OR (CASE h.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 ELSE 4 END,
        (h.sla_due_at IS NULL),COALESCE(date_trunc('milliseconds',h.sla_due_at),'infinity'::timestamptz),date_trunc('milliseconds',h.queued_at),h.id)
        >($5,$6,COALESCE($7::timestamptz,'infinity'::timestamptz),$8::timestamptz,$9::uuid))
    ORDER BY "priorityRank","slaMissing",date_trunc('milliseconds',h.sla_due_at) NULLS LAST,date_trunc('milliseconds',h.queued_at),h.id LIMIT $10`,
    [input.unitId,input.priority??null,input.slaStatus??null,asOf,anchor?.priorityRank??null,anchor?.slaMissing??null,anchor?.slaDueAt??null,
      anchor?.queuedAt??null,anchor?.id??null,limit+1]);
  const rows=result.rows.slice(0,limit),last=rows.at(-1);return{items:rows.map(({priorityRank:_,slaMissing:__,...row})=>row),
    ...(result.rows.length>limit&&last?{nextCursor:Buffer.from(JSON.stringify({v:2,unitId:input.unitId,priorityFilter:input.priority??null,
      slaStatusFilter:input.slaStatus??null,asOf,priorityRank:last.priorityRank,slaMissing:last.slaMissing,
      slaDueAt:last.slaDueAt?new Date(last.slaDueAt).toISOString():null,queuedAt:new Date(last.queuedAt!).toISOString(),id:last.id})).toString("base64url")}:{})};
}
function activeCursor(value:string|undefined,unitId:string):ActiveCursor|null{if(!value)return null;if(value.length>1024||!BASE64URL.test(value))throw new Error("INVALID_PAGE_CURSOR");
  try{const bytes=Buffer.from(value,"base64url");if(bytes.toString("base64url")!==value)throw new Error();const x=JSON.parse(bytes.toString("utf8"))as Record<string,unknown>;
    if(Object.keys(x).sort().join(",")!=="claimedAt,id,unitId,v"||x.v!==1||x.unitId!==unitId||typeof x.id!=="string"||!UUID.test(x.id)
      ||typeof x.claimedAt!=="string"||!ISO_INSTANT.test(x.claimedAt)||new Date(x.claimedAt).toISOString()!==x.claimedAt)throw new Error();return{claimedAt:x.claimedAt,id:x.id,unitId};}
  catch{throw new Error("INVALID_PAGE_CURSOR")}}
export async function listActiveHandoffs(client:TenantQueryClient,input:ListHandoffsInput):Promise<HandoffsPage>{if(!UUID.test(input.unitId))throw new Error("INVALID_UNIT_ID");
  const limit=input.limit??25;if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error("INVALID_PAGE_LIMIT");const anchor=activeCursor(input.cursor,input.unitId);
  const now=input.now??new Date();if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw new Error("INVALID_HANDOFF_CLOCK");
  if(anchor){const valid=await query<{valid:boolean}>(client,`SELECT EXISTS(SELECT 1 FROM human_handoffs h JOIN conversations c ON c.tenant_id=h.tenant_id AND c.id=h.conversation_id
    WHERE h.id=$1 AND h.unit_id=$2 AND h.status='ACTIVE' AND h.assigned_user_id=current_app_actor_id() AND c.automation_status='HUMAN_ACTIVE'
      AND c.assigned_user_id=current_app_actor_id() AND date_trunc('milliseconds',h.claimed_at)=$3) AS valid`,[anchor.id,anchor.unitId,anchor.claimedAt]);
    if(valid.rows[0]?.valid!==true)throw new Error("INVALID_PAGE_CURSOR");}
  const result=await query<InboxHandoff&{claimedAt:Date}>(client,`SELECT h.id,h.conversation_id AS "conversationId",h.service_case_id AS "serviceCaseId",h.unit_id AS "unitId",
    contact.display_name AS "contactName",h.reason,h.priority,h.status,h.assigned_user_id AS "assignedUserId",h.requested_at AS "requestedAt",h.queued_at AS "queuedAt",
    h.sla_due_at AS "slaDueAt",CASE WHEN h.sla_due_at IS NULL THEN NULL WHEN h.sla_due_at<=$4::timestamptz THEN 'OVERDUE'
      WHEN h.sla_due_at<=$4::timestamptz+interval '15 minutes' THEN 'DUE_SOON' ELSE 'ON_TRACK' END AS "slaStatus",
    c.automation_status AS "automationStatus",h.version,h.claimed_at AS "claimedAt"
    FROM human_handoffs h JOIN conversations c ON c.tenant_id=h.tenant_id AND c.id=h.conversation_id JOIN contacts contact ON contact.tenant_id=c.tenant_id AND contact.id=c.contact_id
    WHERE h.unit_id=$1 AND h.status='ACTIVE' AND h.assigned_user_id=current_app_actor_id() AND c.automation_status='HUMAN_ACTIVE' AND c.assigned_user_id=current_app_actor_id()
      AND ($2::timestamptz IS NULL OR (date_trunc('milliseconds',h.claimed_at),h.id)<($2,$3::uuid)) ORDER BY date_trunc('milliseconds',h.claimed_at) DESC,h.id DESC LIMIT $5`,
    [input.unitId,anchor?.claimedAt??null,anchor?.id??null,now.toISOString(),limit+1]);const rows=result.rows.slice(0,limit),last=rows.at(-1);
  return{items:rows.map(({claimedAt:_,...row})=>row),...(result.rows.length>limit&&last?{nextCursor:Buffer.from(JSON.stringify({v:1,unitId:input.unitId,
    claimedAt:new Date(last.claimedAt).toISOString(),id:last.id})).toString("base64url")}:{})};}

function supervisedCursor(value:string|undefined,unitId:string):SupervisedCursor|null{
  if(!value)return null;if(value.length>1024||!BASE64URL.test(value))throw new Error("INVALID_PAGE_CURSOR");
  try{const bytes=Buffer.from(value,"base64url");if(bytes.toString("base64url")!==value)throw new Error();
    const x=JSON.parse(bytes.toString("utf8"))as Record<string,unknown>;
    if(Object.keys(x).sort().join(",")!=="claimedAt,id,scope,unitId,v"||x.v!==1||x.scope!=="UNIT"||x.unitId!==unitId
      ||typeof x.id!=="string"||!UUID.test(x.id)||typeof x.claimedAt!=="string"||!ISO_INSTANT.test(x.claimedAt)
      ||new Date(x.claimedAt).toISOString()!==x.claimedAt)throw new Error();
    return x as unknown as SupervisedCursor;
  }catch{throw new Error("INVALID_PAGE_CURSOR")}
}

export interface ListSupervisedHandoffsInput{readonly unitId:string;readonly limit?:number;readonly cursor?:string;readonly now?:Date}
export async function listSupervisedHandoffs(client:TenantQueryClient,input:ListSupervisedHandoffsInput):Promise<HandoffsPage>{
  if(!UUID.test(input.unitId))throw new Error("INVALID_UNIT_ID");const limit=input.limit??25;
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error("INVALID_PAGE_LIMIT");
  const anchor=supervisedCursor(input.cursor,input.unitId),now=input.now??new Date();
  if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw new Error("INVALID_HANDOFF_CLOCK");
  const result=await query<InboxHandoff&{claimedAt:Date}>(client,`SELECT id,conversation_id AS "conversationId",
    service_case_id AS "serviceCaseId",unit_id AS "unitId",contact_name AS "contactName",reason,priority,status,
    assigned_user_id AS "assignedUserId",requested_at AS "requestedAt",queued_at AS "queuedAt",sla_due_at AS "slaDueAt",
    sla_status AS "slaStatus",automation_status AS "automationStatus",version,claimed_at AS "claimedAt"
    FROM list_inbox_supervised_handoffs($1,$2,$3::timestamptz,$4::uuid,$5::timestamptz)`,
    [input.unitId,limit+1,anchor?.claimedAt??null,anchor?.id??null,now.toISOString()]);
  const rows=result.rows.slice(0,limit),last=rows.at(-1);return{items:rows.map(({claimedAt:_,...item})=>item),
    ...(result.rows.length>limit&&last?{nextCursor:Buffer.from(JSON.stringify({v:1,scope:"UNIT",unitId:input.unitId,
      claimedAt:new Date(last.claimedAt).toISOString(),id:last.id})).toString("base64url")}:{})};
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
  const serviceCaseId = input.serviceCaseId.trim().toLowerCase();
  const reason = requiredText(input.reason, "INVALID_HANDOFF_REASON", 200);
  const idempotencyKey = requiredText(input.idempotencyKey, "INVALID_IDEMPOTENCY_KEY", 200);
  if (!["LOW", "NORMAL", "HIGH", "URGENT"].includes(input.priority)) {
    throw new Error("INVALID_HANDOFF_PRIORITY");
  }
  // SLA is selected from the unit's published policy. The caller field remains
  // accepted only for source compatibility and is never trusted for new rows.
  const legacySlaDueAt = input.slaDueAt === undefined ? null : input.slaDueAt.toISOString();
  const requestFingerprint = createHash("sha256").update(JSON.stringify({
    serviceCaseId,
    reason,
    priority: input.priority,
  })).digest("hex");
  const legacyRequestFingerprint = createHash("sha256").update(JSON.stringify({
    serviceCaseId, reason, priority: input.priority, slaDueAt: legacySlaDueAt,
  })).digest("hex");

  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended(current_app_tenant_id()::text || ':handoff-request:' || $1, 0))",
    [idempotencyKey],
  );

  const existing = await query<HandoffResult & { conversationId: string; serviceCaseId: string;
    reason: string; priority: RequestHandoffInput["priority"]; slaDueAt: Date | null; requestFingerprint: string | null }>(client, `
    SELECT id, conversation_id AS "conversationId", service_case_id AS "serviceCaseId", status, version,
      reason, priority, sla_due_at AS "slaDueAt", request_fingerprint AS "requestFingerprint"
    FROM human_handoffs WHERE idempotency_key = $1
  `, [idempotencyKey]);
  if (existing.rowCount === 1) {
    const replay = existing.rows[0]!;
    const legacyMatches = replay.serviceCaseId.toLowerCase() === serviceCaseId
      && replay.reason === reason && replay.priority === input.priority
      && (replay.slaDueAt === null ? null : new Date(replay.slaDueAt).toISOString()) === legacySlaDueAt;
    if (replay.requestFingerprint !== null
      ? replay.requestFingerprint !== requestFingerprint && replay.requestFingerprint !== legacyRequestFingerprint
      : !legacyMatches) {
      throw new Error("IDEMPOTENCY_KEY_REUSED");
    }
    return replay;
  }

  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended(current_app_tenant_id()::text || ':handoff-case:' || $1, 0))",
    [serviceCaseId],
  );

  const serviceCase = await query<ServiceCaseRow>(client, `
    SELECT conversation_id, unit_id, status, version
    FROM service_cases WHERE id = $1 FOR UPDATE
  `, [serviceCaseId]);
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

  const policy = await query<{ policyVersionId:string;targetMinutes:number }>(client, `
    SELECT policy_version_id AS "policyVersionId",target_minutes AS "targetMinutes"
    FROM resolve_unit_sla_policy_target($1,$2)
  `,[current.unit_id,input.priority]);
  const selectedPolicy=policy.rows[0]??null;

  const created = await query<{ id: string; version: number }>(client, `
    INSERT INTO human_handoffs
      (tenant_id, conversation_id, service_case_id, unit_id, reason, priority,
       status, queued_at, sla_due_at, sla_policy_version_id, idempotency_key, request_fingerprint)
    VALUES (current_app_tenant_id(), $1, $2, $3, $4, $5, 'QUEUED', now(),
      CASE WHEN $6::integer IS NULL THEN NULL ELSE now()+make_interval(mins=>$6) END,$7,$8,$9)
    RETURNING id, version
  `, [current.conversation_id, serviceCaseId, current.unit_id, reason, input.priority,
    selectedPolicy?.targetMinutes??null,selectedPolicy?.policyVersionId??null,idempotencyKey,requestFingerprint]);
  const handoff = created.rows[0]!;

  const waitingCase = await query<{ version: number }>(client, `
    UPDATE service_cases SET status = 'WAITING_HUMAN', version = version + 1,
      state_changed_at = now()
    WHERE id = $1 AND version = $2 AND status IN ('COLLECTING', 'READY_FOR_HANDOFF')
    RETURNING version
  `, [serviceCaseId, input.expectedCaseVersion]);
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
  `, [serviceCaseId, current.status, reason, handoff.id, current.conversation_id]);
  await client.query(`
    INSERT INTO outbox_events
      (tenant_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key)
    VALUES (current_app_tenant_id(), 'handoff', $1, 'handoff.queued',
      jsonb_build_object('handoffId', $1::uuid, 'conversationId', $2::uuid, 'serviceCaseId', $3::uuid), $4::text)
  `, [handoff.id, current.conversation_id, serviceCaseId, `handoff.queued:${handoff.id}`]);

  return {
    id: handoff.id,
    conversationId: current.conversation_id,
    serviceCaseId,
    status: "QUEUED",
    version: handoff.version,
  };
}

async function replayedClaim(client: TenantQueryClient, input: ClaimHandoffInput): Promise<HandoffResult | null> {
  const command = await query<{
    handoff_id: string; expected_version: number; actor_id: string; result_version: number;
    conversation_id: string; service_case_id: string; assigned_user_id: string; automation_status: string;
  }>(client, `
    SELECT command.handoff_id, command.expected_version, command.actor_id, command.result_version,
      command.conversation_id, command.service_case_id, command.result_assigned_user_id AS assigned_user_id,
      command.result_automation_status AS automation_status
    FROM handoff_claim_commands command
    WHERE command.idempotency_key=$1
  `, [input.idempotencyKey]);
  if (command.rowCount === 0) return null;
  const row = command.rows[0]!;
  const actor = await query<{ id: string }>(client, "SELECT current_app_actor_id() AS id", []);
  if (row.handoff_id !== input.handoffId || row.expected_version !== input.expectedVersion
    || row.actor_id !== actor.rows[0]!.id) throw new Error("IDEMPOTENCY_KEY_REUSED");
  return { id: row.handoff_id, conversationId: row.conversation_id, serviceCaseId: row.service_case_id,
    status: "ACTIVE", version: row.result_version, assignedUserId: row.assigned_user_id,
    automationStatus: row.automation_status, replayed: true };
}

/** Claim otimista: apenas uma atualização com a versão esperada pode vencer. */
export async function claimHandoff(
  client: TenantQueryClient,
  input: ClaimHandoffInput,
): Promise<HandoffResult> {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new Error("INVALID_EXPECTED_VERSION");
  }
  const normalizedKey=requiredText(input.idempotencyKey, "INVALID_IDEMPOTENCY_KEY", 200);
  const normalizedInput={...input,idempotencyKey:normalizedKey};
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_app_tenant_id()::text||':handoff-claim:'||$1,0))",[normalizedKey]);
  const replay = await replayedClaim(client, normalizedInput);
  if (replay) return replay;
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
    const concurrentReplay = await replayedClaim(client, normalizedInput);
    if (concurrentReplay) return concurrentReplay;
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
  `, [current.id, `handoff.claimed:${current.id}:${claimedVersion}`]);
  await client.query(`
    INSERT INTO handoff_claim_commands
      (tenant_id,idempotency_key,handoff_id,expected_version,actor_id,result_version,correlation_id,
       conversation_id,service_case_id,result_assigned_user_id,result_automation_status)
    VALUES (current_app_tenant_id(),$1,$2,$3,current_app_actor_id(),$4,current_setting('app.correlation_id'),
      $5,$6,current_app_actor_id(),'HUMAN_ACTIVE')
  `, [normalizedKey, current.id, input.expectedVersion, claimedVersion,current.conversation_id,current.service_case_id]);

  return {
    id: current.id,
    conversationId: current.conversation_id,
    serviceCaseId: current.service_case_id,
    status: "ACTIVE",
    version: claimedVersion,
    assignedUserId: (await query<{ id: string }>(client, "SELECT current_app_actor_id() AS id", [])).rows[0]!.id,
    automationStatus: "HUMAN_ACTIVE",
    replayed: false,
  };
}

export interface RequeueHandoffInput { handoffId:string; expectedVersion:number; idempotencyKey:string }
export async function requeueHandoff(client:TenantQueryClient,input:RequeueHandoffInput){
  if(!UUID.test(input.handoffId)||!Number.isInteger(input.expectedVersion)||input.expectedVersion<1)throw new Error("INVALID_HANDOFF_REQUEUE_REQUEST");
  const key=requiredText(input.idempotencyKey,"INVALID_IDEMPOTENCY_KEY",200);
  const result=await client.query(`SELECT handoff_id AS "handoffId",conversation_id AS "conversationId",service_case_id AS "serviceCaseId",
    handoff_version AS "handoffVersion",conversation_version AS "conversationVersion",service_case_version AS "serviceCaseVersion",replayed
    FROM requeue_inbox_handoff($1,$2,$3)`,[input.handoffId,input.expectedVersion,key]) as{rows:{handoffId:string;conversationId:string;serviceCaseId:string;
      handoffVersion:number;conversationVersion:number;serviceCaseVersion:number;replayed:boolean}[]};
  const row=result.rows[0];if(!row)throw new Error("HANDOFF_REQUEUE_FAILED");return row;
}
export const REOPEN_REASONS=["FOLLOW_UP_REQUIRED","PREMATURE_CLOSURE","NEW_INFORMATION","OPERATIONAL_CORRECTION"] as const;
export type ReopenReason=(typeof REOPEN_REASONS)[number];
export interface ReopenHandoffInput{readonly handoffId:string;readonly expectedVersion:number;readonly reason:ReopenReason;readonly idempotencyKey:string}
export function reopenFingerprint(input:{handoffId:string;expectedVersion:number;reason:ReopenReason}){return createHash("sha256").update(JSON.stringify({
  expectedVersion:input.expectedVersion,handoffId:input.handoffId.toLowerCase(),reason:input.reason})).digest("hex")}
function assertReopenInput(input:ReopenHandoffInput){if(!UUID.test(input.handoffId)||!Number.isInteger(input.expectedVersion)||input.expectedVersion<1
  ||!REOPEN_REASONS.includes(input.reason))throw new Error("INVALID_HANDOFF_REOPEN_REQUEST")}
export async function resolveReopenUnit(client:TenantQueryClient,input:ReopenHandoffInput){assertReopenInput(input);
  const key=requiredText(input.idempotencyKey,"INVALID_IDEMPOTENCY_KEY",200),fingerprint=reopenFingerprint(input);
  const result=await client.query(`SELECT resolve_inbox_handoff_reopen_unit($1,$2,$3,$4,$5) AS "unitId"`,
    [input.handoffId,input.expectedVersion,input.reason,key,fingerprint])as{rows:{unitId:string|null}[]};return result.rows[0]?.unitId??null}
export async function reopenHandoff(client:TenantQueryClient,input:ReopenHandoffInput){assertReopenInput(input);
  const key=requiredText(input.idempotencyKey,"INVALID_IDEMPOTENCY_KEY",200),fingerprint=reopenFingerprint(input);
  const result=await client.query(`SELECT source_handoff_id AS "sourceHandoffId",handoff_id AS "handoffId",conversation_id AS "conversationId",
    service_case_id AS "serviceCaseId",handoff_version AS "handoffVersion",conversation_version AS "conversationVersion",
    service_case_version AS "serviceCaseVersion",replayed FROM reopen_inbox_handoff($1,$2,$3,$4,$5)`,
    [input.handoffId,input.expectedVersion,input.reason,key,fingerprint])as{rows:{sourceHandoffId:string;handoffId:string;conversationId:string;
      serviceCaseId:string;handoffVersion:number;conversationVersion:number;serviceCaseVersion:number;replayed:boolean}[]};
  const row=result.rows[0];if(!row)throw new Error("HANDOFF_REOPEN_NOT_FOUND");return row}
export async function listTransferCandidates(client:TenantQueryClient,handoffId:string){
  if(!UUID.test(handoffId))throw new Error("INVALID_HANDOFF_TRANSFER_REQUEST");
  const result=await client.query(`SELECT id,display_name AS "displayName" FROM list_inbox_handoff_transfer_candidates($1)`,[handoffId]) as{rows:{id:string;displayName:string}[]};
  return{items:result.rows};
}
export const TRANSFER_REASONS=["SHIFT_CHANGE","LOAD_BALANCING","SPECIALIZED_SUPPORT","OPERATIONAL_CONTINUITY"] as const;
export type TransferReason=(typeof TRANSFER_REASONS)[number];
export function transferFingerprint(input:{handoffId:string;expectedVersion:number;targetUserId:string;reason:TransferReason}){return createHash("sha256").update(JSON.stringify({
  expectedVersion:input.expectedVersion,handoffId:input.handoffId.toLowerCase(),reason:input.reason,targetUserId:input.targetUserId.toLowerCase()})).digest("hex")}
export async function transferHandoff(client:TenantQueryClient,input:{handoffId:string;expectedVersion:number;targetUserId:string;reason:TransferReason;idempotencyKey:string}){
  if(!UUID.test(input.handoffId)||!UUID.test(input.targetUserId)||!Number.isInteger(input.expectedVersion)||input.expectedVersion<1||!TRANSFER_REASONS.includes(input.reason))throw new Error("INVALID_HANDOFF_TRANSFER_REQUEST");
  const key=requiredText(input.idempotencyKey,"INVALID_IDEMPOTENCY_KEY",200),fingerprint=transferFingerprint(input);
  const result=await client.query(`SELECT handoff_id AS "handoffId",conversation_id AS "conversationId",service_case_id AS "serviceCaseId",
    target_user_id AS "targetUserId",handoff_version AS "handoffVersion",conversation_version AS "conversationVersion",replayed
    FROM transfer_inbox_handoff($1,$2,$3,$4,$5,$6)`,[input.handoffId,input.expectedVersion,input.targetUserId,input.reason,key,fingerprint]) as{rows:{handoffId:string;conversationId:string;
      serviceCaseId:string;targetUserId:string;handoffVersion:number;conversationVersion:number;replayed:boolean}[]};
  const row=result.rows[0];if(!row)throw new Error("HANDOFF_TRANSFER_NOT_FOUND");return row;
}

export interface TakeoverHandoffInput{readonly handoffId:string;readonly expectedVersion:number;readonly idempotencyKey:string}
export function takeoverFingerprint(input:{handoffId:string;expectedVersion:number}){return createHash("sha256").update(JSON.stringify({
  expectedVersion:input.expectedVersion,handoffId:input.handoffId.toLowerCase()})).digest("hex")}
export async function getTakeoverTarget(client:TenantQueryClient,conversationId:string){
  if(!UUID.test(conversationId))throw new Error("INVALID_HANDOFF_TAKEOVER_REQUEST");
  const result=await client.query(`SELECT handoff_id AS "handoffId",expected_version AS "expectedVersion"
    FROM get_inbox_conversation_takeover_target($1)`,[conversationId])as{rows:{handoffId:string;expectedVersion:number}[]};
  return result.rows[0]??null;
}
export async function resolveTakeoverUnit(client:TenantQueryClient,input:TakeoverHandoffInput){
  if(!UUID.test(input.handoffId)||!Number.isInteger(input.expectedVersion)||input.expectedVersion<1)
    throw new Error("INVALID_HANDOFF_TAKEOVER_REQUEST");
  const key=requiredText(input.idempotencyKey,"INVALID_IDEMPOTENCY_KEY",200),fingerprint=takeoverFingerprint(input);
  const result=await client.query(`SELECT resolve_inbox_handoff_takeover_unit($1,$2,$3,$4) AS "unitId"`,
    [input.handoffId,input.expectedVersion,key,fingerprint])as{rows:{unitId:string|null}[]};
  return result.rows[0]?.unitId??null;
}
export async function takeoverHandoff(client:TenantQueryClient,input:TakeoverHandoffInput){
  if(!UUID.test(input.handoffId)||!Number.isInteger(input.expectedVersion)||input.expectedVersion<1)
    throw new Error("INVALID_HANDOFF_TAKEOVER_REQUEST");
  const key=requiredText(input.idempotencyKey,"INVALID_IDEMPOTENCY_KEY",200),fingerprint=takeoverFingerprint(input);
  const result=await client.query(`SELECT handoff_id AS "handoffId",conversation_id AS "conversationId",
    service_case_id AS "serviceCaseId",previous_assigned_user_id AS "previousAssignedUserId",
    handoff_version AS "handoffVersion",conversation_version AS "conversationVersion",replayed
    FROM takeover_inbox_handoff($1,$2,$3,$4)`,[input.handoffId,input.expectedVersion,key,fingerprint])as{rows:{handoffId:string;
      conversationId:string;serviceCaseId:string;previousAssignedUserId:string;handoffVersion:number;conversationVersion:number;replayed:boolean}[]};
  const row=result.rows[0];if(!row)throw new Error("HANDOFF_TAKEOVER_NOT_FOUND");return row;
}
