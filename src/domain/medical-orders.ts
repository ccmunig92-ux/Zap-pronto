import { createHash } from "node:crypto";
import type { TenantQueryClient } from "../database/tenant-transaction.js";
import { requestHandoff } from "./handoffs.js";

interface QueryResult<Row> { readonly rowCount: number | null; readonly rows: readonly Row[] }
async function query<Row>(client: TenantQueryClient, text: string, values: unknown[]): Promise<QueryResult<Row>> {
  return await client.query(text, values) as QueryResult<Row>;
}

export interface ReceiveMedicalOrderInput {
  readonly serviceCaseId: string;
  readonly messageId: string;
  readonly attachmentId: string;
  readonly documentSha256: string;
  readonly pageCount: number;
  readonly idempotencyKey: string;
}
export interface ExtractedItemInput {
  readonly sequence: number;
  readonly rawText: string;
  readonly normalizedText?: string;
  readonly suggestedCatalogItemId?: string;
  readonly confidence?: number;
}
export interface ExtractedPageInput {
  readonly pageNumber: number;
  readonly ocrText: string;
  readonly confidence: number;
  readonly items: readonly ExtractedItemInput[];
}
export interface ApplyExtractionInput {
  readonly medicalOrderId: string;
  readonly expectedOrderVersion: number;
  readonly expectedCaseVersion: number;
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string;
  readonly confidenceThreshold: number;
  readonly confidencePolicyVersion: string;
  readonly pages: readonly ExtractedPageInput[];
  readonly idempotencyKey: string;
}
export interface MedicalOrderResult {
  readonly id: string;
  readonly status: "PROCESSING" | "REVIEW_REQUIRED" | "REVIEWED" | "UNREADABLE";
  readonly version: number;
}

function key(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 200) throw new Error("INVALID_IDEMPOTENCY_KEY");
  return normalized;
}
function confidence(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("INVALID_CONFIDENCE");
}
function requiredText(value: string, code: string, max = 100): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > max) throw new Error(code);
  return normalized;
}

async function ensureMedicalOrderHandoff(
  client: TenantQueryClient,
  input: { serviceCaseId: string; conversationId: string; expectedCaseVersion: number;
    reason: string; priority: "NORMAL" | "HIGH"; idempotencyKey: string },
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended(current_app_tenant_id()::text || ':handoff-case:' || $1, 0))",
    [input.serviceCaseId],
  );
  const existing = await query<{ id: string; service_case_id: string }>(client, `
    SELECT id, service_case_id FROM human_handoffs
    WHERE conversation_id=$1 AND status IN ('REQUESTED','QUEUED','ACTIVE')
    ORDER BY requested_at, id LIMIT 1 FOR UPDATE
  `, [input.conversationId]);
  if (existing.rowCount === 0) {
    await requestHandoff(client, input);
    return;
  }
  if (existing.rows[0]!.service_case_id !== input.serviceCaseId) {
    throw new Error("HANDOFF_OPEN_FOR_ANOTHER_CASE");
  }
  const serviceCase = await query<{ status: string; version: number }>(client, `
    SELECT status, version FROM service_cases WHERE id=$1 FOR UPDATE
  `, [input.serviceCaseId]);
  if (serviceCase.rowCount !== 1) throw new Error("SERVICE_CASE_NOT_FOUND");
  const current = serviceCase.rows[0]!;
  if (current.status === "WAITING_HUMAN" || current.status === "IN_REVIEW") return;
  if (current.version !== input.expectedCaseVersion
    || !["COLLECTING", "READY_FOR_HANDOFF"].includes(current.status)) {
    throw new Error("CONCURRENT_MODIFICATION");
  }
  const moved = await query<{ version: number }>(client, `
    UPDATE service_cases SET status='WAITING_HUMAN', version=version+1, state_changed_at=now()
    WHERE id=$1 AND version=$2 AND status IN ('COLLECTING','READY_FOR_HANDOFF') RETURNING version
  `, [input.serviceCaseId, input.expectedCaseVersion]);
  if (moved.rowCount !== 1) throw new Error("CONCURRENT_MODIFICATION");
  await client.query(`
    INSERT INTO workflow_transitions
      (tenant_id, aggregate_type, aggregate_id, from_status, to_status, reason,
       actor_id, correlation_id, metadata)
    VALUES (current_app_tenant_id(), 'SERVICE_CASE', $1, $2, 'WAITING_HUMAN', $3,
      current_app_actor_id(), current_setting('app.correlation_id'),
      jsonb_build_object('reusedHandoffId', $4::uuid))
  `, [input.serviceCaseId, current.status, input.reason, existing.rows[0]!.id]);
}

export async function receiveMedicalOrder(
  client: TenantQueryClient,
  input: ReceiveMedicalOrderInput,
): Promise<MedicalOrderResult> {
  const idempotencyKey = key(input.idempotencyKey);
  if (!/^[0-9a-f]{64}$/.test(input.documentSha256)) throw new Error("INVALID_DOCUMENT_HASH");
  if (!Number.isInteger(input.pageCount) || input.pageCount < 1 || input.pageCount > 100) {
    throw new Error("INVALID_PAGE_COUNT");
  }
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended(current_app_tenant_id()::text || ':medical-source:' || $1 || ':' || $2, 0))",
    [input.serviceCaseId, input.documentSha256],
  );
  const existing = await query<{ id: string; status: MedicalOrderResult["status"]; version: number;
    service_case_id: string; message_id: string; message_attachment_id: string;
    document_sha256: string; page_count: number }>(client, `
    SELECT id, status, version, service_case_id, message_id, message_attachment_id, document_sha256, page_count
    FROM medical_orders WHERE idempotency_key = $1
  `, [idempotencyKey]);
  if (existing.rowCount === 1) {
    const row = existing.rows[0]!;
    if (row.service_case_id !== input.serviceCaseId || row.message_id !== input.messageId
      || row.message_attachment_id !== input.attachmentId || row.page_count !== input.pageCount
      || row.document_sha256 !== input.documentSha256) throw new Error("IDEMPOTENCY_KEY_REUSED");
    return { id: row.id, status: row.status, version: row.version };
  }
  const sameDocument = await query<{ id: string; status: MedicalOrderResult["status"]; version: number;
    message_id: string; message_attachment_id: string; page_count: number }>(client, `
    SELECT id,status,version,message_id,message_attachment_id,page_count FROM medical_orders
    WHERE service_case_id=$1 AND document_sha256=$2
  `, [input.serviceCaseId, input.documentSha256]);
  if (sameDocument.rowCount === 1) {
    const row = sameDocument.rows[0]!;
    if (row.message_id !== input.messageId || row.message_attachment_id !== input.attachmentId
      || row.page_count !== input.pageCount) throw new Error("MEDICAL_ORDER_DOCUMENT_REUSED");
    return { id: row.id, status: row.status, version: row.version };
  }
  const source = await query<{ conversation_id: string; unit_id: string; sha256: string }>(client, `
    SELECT service_case.conversation_id, service_case.unit_id, attachment.sha256
    FROM service_cases service_case
    JOIN messages message ON message.tenant_id = service_case.tenant_id
      AND message.id = $2 AND message.conversation_id = service_case.conversation_id
    JOIN message_attachments attachment ON attachment.tenant_id = message.tenant_id
      AND attachment.id = $3 AND attachment.message_id = message.id
      AND attachment.media_type IN ('IMAGE', 'DOCUMENT')
    WHERE service_case.id = $1 AND service_case.unit_id IS NOT NULL
      AND service_case.kind = 'MEDICAL_ORDER' AND message.direction='INBOUND' AND message.actor='CUSTOMER'
    FOR SHARE OF service_case, message, attachment
  `, [input.serviceCaseId, input.messageId, input.attachmentId]);
  if (source.rowCount !== 1) throw new Error("MEDICAL_ORDER_SOURCE_INVALID");
  if (source.rows[0]!.sha256 !== input.documentSha256) throw new Error("DOCUMENT_HASH_MISMATCH");

  const created = await query<{ id: string }>(client, `
    INSERT INTO medical_orders
      (tenant_id, service_case_id, conversation_id, unit_id, message_id, message_attachment_id,
       document_sha256, page_count, idempotency_key)
    VALUES (current_app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id
  `, [input.serviceCaseId, source.rows[0]!.conversation_id, source.rows[0]!.unit_id,
    input.messageId, input.attachmentId, input.documentSha256, input.pageCount, idempotencyKey]);
  const orderId = created.rows[0]!.id;
  for (let pageNumber = 1; pageNumber <= input.pageCount; pageNumber += 1) {
    await client.query(`
      INSERT INTO medical_order_pages (tenant_id, medical_order_id, page_number)
      VALUES (current_app_tenant_id(), $1, $2)
    `, [orderId, pageNumber]);
  }
  const processing = await query<{ version: number }>(client, `
    UPDATE medical_orders SET status='PROCESSING', version=version+1, updated_at=now()
    WHERE id=$1 AND status='RECEIVED' AND version=1 RETURNING version
  `, [orderId]);
  return { id: orderId, status: "PROCESSING", version: processing.rows[0]!.version };
}

export async function applyMedicalOrderExtraction(
  client: TenantQueryClient,
  input: ApplyExtractionInput,
): Promise<MedicalOrderResult> {
  const idempotencyKey = key(input.idempotencyKey);
  const provider = requiredText(input.provider, "INVALID_PROCESSING_PROVIDER");
  const model = requiredText(input.model, "INVALID_PROCESSING_MODEL");
  const modelVersion = requiredText(input.modelVersion, "INVALID_PROCESSING_VERSION");
  const confidencePolicyVersion = requiredText(input.confidencePolicyVersion, "INVALID_CONFIDENCE_POLICY_VERSION");
  confidence(input.confidenceThreshold);
  if (input.pages.length < 1) throw new Error("INVALID_EXTRACTION_PAGES");
  for (const page of input.pages) {
    confidence(page.confidence);
    if (!Number.isInteger(page.pageNumber) || page.pageNumber < 1 || page.ocrText.trim().length === 0) {
      throw new Error("INVALID_EXTRACTION_PAGE");
    }
    for (const item of page.items) {
      if (!Number.isInteger(item.sequence) || item.sequence < 1 || item.rawText.trim().length === 0) {
        throw new Error("INVALID_EXTRACTED_ITEM");
      }
      if (item.confidence !== undefined) confidence(item.confidence);
    }
  }
  const fingerprint = createHash("sha256").update(JSON.stringify({
    orderId: input.medicalOrderId, provider, model, modelVersion,
    confidenceThreshold: input.confidenceThreshold, confidencePolicyVersion, pages: input.pages,
  })).digest("hex");
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended(current_app_tenant_id()::text || ':' || $1, 0))",
    [idempotencyKey],
  );
  const order = await query<{ service_case_id: string; conversation_id: string; page_count: number;
    status: string; version: number; extraction_fingerprint: string | null;
    extraction_idempotency_key: string | null }>(client, `
    SELECT service_case_id, conversation_id, page_count, status, version,
      extraction_fingerprint, extraction_idempotency_key
    FROM medical_orders WHERE id=$1 FOR UPDATE
  `, [input.medicalOrderId]);
  if (order.rowCount !== 1) throw new Error("MEDICAL_ORDER_NOT_FOUND");
  const current = order.rows[0]!;
  if (current.status === "REVIEW_REQUIRED" && current.extraction_fingerprint === fingerprint
    && current.extraction_idempotency_key === idempotencyKey) {
    return { id: input.medicalOrderId, status: "REVIEW_REQUIRED", version: current.version };
  }
  if (current.extraction_idempotency_key === idempotencyKey
    && current.extraction_fingerprint !== null && current.extraction_fingerprint !== fingerprint) {
    throw new Error("IDEMPOTENCY_KEY_REUSED");
  }
  if (current.status !== "PROCESSING" || current.version !== input.expectedOrderVersion) {
    throw new Error("MEDICAL_ORDER_EXTRACTION_CONFLICT");
  }
  if (input.pages.length !== current.page_count
    || new Set(input.pages.map((page) => page.pageNumber)).size !== current.page_count) {
    throw new Error("MEDICAL_ORDER_PAGE_COUNT_MISMATCH");
  }
  let overallConfidence = 1;
  let itemCount = 0;
  for (const page of input.pages) {
    overallConfidence = Math.min(overallConfidence, page.confidence);
    const updatedPage = await query<{ id: string }>(client, `
      UPDATE medical_order_pages SET status='OCR_COMPLETED', ocr_text=$1, ocr_confidence=$2,
        updated_at=now()
      WHERE medical_order_id=$3 AND page_number=$4 AND status='PENDING'
      RETURNING id
    `, [page.ocrText, page.confidence, input.medicalOrderId, page.pageNumber]);
    if (updatedPage.rowCount !== 1) throw new Error("MEDICAL_ORDER_PAGE_CONFLICT");
    for (const item of page.items) {
      itemCount += 1;
      const itemConfidence = item.confidence ?? 0;
      overallConfidence = Math.min(overallConfidence, itemConfidence);
      await client.query(`
        INSERT INTO medical_order_items
          (tenant_id, medical_order_id, page_id, sequence, raw_text, normalized_text,
           suggested_catalog_item_id, match_confidence, status)
        VALUES (current_app_tenant_id(), $1, $2, $3, $4, $5, $6, $7,
          CASE WHEN $6::uuid IS NULL THEN 'EXTRACTED'::medical_order_item_status
            ELSE 'MATCH_SUGGESTED'::medical_order_item_status END)
      `, [input.medicalOrderId, updatedPage.rows[0]!.id, item.sequence, item.rawText,
        item.normalizedText ?? null, item.suggestedCatalogItemId ?? null, item.confidence ?? null]);
    }
  }
  if (itemCount < 1) throw new Error("MEDICAL_ORDER_NO_ITEMS");
  const transitioned = await query<{ version: number }>(client, `
    UPDATE medical_orders SET status='REVIEW_REQUIRED', overall_confidence=$1,
      extraction_fingerprint=$2, extraction_idempotency_key=$3,
      processing_provider=$4, processing_model=$5, processing_version=$6,
      confidence_threshold=$7, confidence_policy_version=$8,
      version=version+1, updated_at=now()
    WHERE id=$9 AND status='PROCESSING' AND version=$10 RETURNING version
  `, [overallConfidence, fingerprint, idempotencyKey, provider, model, modelVersion,
    input.confidenceThreshold, confidencePolicyVersion,
    input.medicalOrderId, input.expectedOrderVersion]);
  if (transitioned.rowCount !== 1) throw new Error("MEDICAL_ORDER_EXTRACTION_CONFLICT");

  await ensureMedicalOrderHandoff(client, {
    conversationId: current.conversation_id,
    serviceCaseId: current.service_case_id,
    expectedCaseVersion: input.expectedCaseVersion,
    reason: overallConfidence < input.confidenceThreshold ? "PROCEDURE_AMBIGUOUS" : "COMPLETED_COLLECTION",
    priority: overallConfidence < input.confidenceThreshold ? "HIGH" : "NORMAL",
    idempotencyKey: `medical-order-review:${input.medicalOrderId}`,
  });
  return { id: input.medicalOrderId, status: "REVIEW_REQUIRED", version: transitioned.rows[0]!.version };
}

export interface ReviewDecision {
  readonly itemId: string;
  readonly action: "CONFIRM" | "REJECT";
  readonly confirmedCatalogItemId?: string;
  readonly reason?: string;
}
export async function reviewMedicalOrder(
  client: TenantQueryClient,
  medicalOrderId: string,
  expectedVersion: number,
  decisions: readonly ReviewDecision[],
): Promise<MedicalOrderResult> {
  if (new Set(decisions.map((decision) => decision.itemId)).size !== decisions.length) {
    throw new Error("MEDICAL_ORDER_REVIEW_DUPLICATE_ITEM");
  }
  const order = await query<{ status: string; version: number }>(client, `
    SELECT medical.status, medical.version FROM medical_orders medical
    WHERE medical.id=$1 AND EXISTS (SELECT 1 FROM user_units membership
      WHERE membership.tenant_id=medical.tenant_id AND membership.unit_id=medical.unit_id
        AND membership.user_id=current_app_actor_id() AND membership.status='ACTIVE') FOR UPDATE
  `, [medicalOrderId]);
  if (order.rowCount === 1 && order.rows[0]!.status === "REVIEWED") {
    if (decisions.length < 1) throw new Error("MEDICAL_ORDER_REVIEW_EMPTY");
    const reviewedItems = await query<{ id: string; status: string; confirmed_catalog_item_id: string | null;
      rejection_reason: string | null }>(client, `
      SELECT id,status,confirmed_catalog_item_id,rejection_reason FROM medical_order_items
      WHERE medical_order_id=$1 ORDER BY sequence
    `, [medicalOrderId]);
    if (reviewedItems.rowCount !== decisions.length) throw new Error("MEDICAL_ORDER_REVIEW_CONFLICT");
    const byId = new Map(reviewedItems.rows.map((item) => [item.id, item]));
    const replay = decisions.every((decision) => {
      const item = byId.get(decision.itemId);
      return decision.action === "CONFIRM"
        ? item?.status === "CONFIRMED" && item.confirmed_catalog_item_id === decision.confirmedCatalogItemId
        : item?.status === "REJECTED" && item.rejection_reason === decision.reason?.trim();
    });
    if (!replay) throw new Error("MEDICAL_ORDER_REVIEW_CONFLICT");
    return { id: medicalOrderId, status: "REVIEWED", version: order.rows[0]!.version };
  }
  if (order.rowCount !== 1 || order.rows[0]!.status !== "REVIEW_REQUIRED"
    || order.rows[0]!.version !== expectedVersion) throw new Error("MEDICAL_ORDER_REVIEW_CONFLICT");
  if (decisions.length < 1) throw new Error("MEDICAL_ORDER_REVIEW_EMPTY");
  for (const decision of decisions) {
    const confirmed = decision.action === "CONFIRM";
    if (confirmed && !decision.confirmedCatalogItemId) throw new Error("CONFIRMED_CATALOG_ITEM_REQUIRED");
    if (!confirmed && (!decision.reason || decision.reason.trim().length === 0)) {
      throw new Error("REJECTION_REASON_REQUIRED");
    }
    const reviewed = await query<{ suggested_catalog_item_id: string | null }>(client, `
      UPDATE medical_order_items SET status=$1,
        confirmed_catalog_item_id=$2, reviewed_by_user_id=current_app_actor_id(), reviewed_at=now(),
        rejection_reason=$3, updated_at=now()
      WHERE id=$4 AND medical_order_id=$5 AND status IN ('EXTRACTED','MATCH_SUGGESTED')
      RETURNING suggested_catalog_item_id
    `, [confirmed ? "CONFIRMED" : "REJECTED", decision.confirmedCatalogItemId ?? null,
      confirmed ? null : decision.reason!.trim(), decision.itemId, medicalOrderId]);
    if (reviewed.rowCount !== 1) throw new Error("MEDICAL_ORDER_ITEM_REVIEW_CONFLICT");
    const corrected = confirmed && reviewed.rows[0]!.suggested_catalog_item_id !== decision.confirmedCatalogItemId;
    await client.query(`
      INSERT INTO medical_order_review_events
        (tenant_id, medical_order_id, medical_order_item_id, action, actor_id, correlation_id, idempotency_key)
      VALUES (current_app_tenant_id(), $1, $2, $3, current_app_actor_id(),
        current_setting('app.correlation_id'), $4)
    `, [medicalOrderId, decision.itemId, confirmed ? (corrected ? "CORRECTED" : "CONFIRMED") : "REJECTED",
      `medical-review:${medicalOrderId}:${decision.itemId}`]);
  }
  const pending = await query<{ count: number }>(client, `
    SELECT count(*)::integer AS count FROM medical_order_items
    WHERE medical_order_id=$1 AND status NOT IN ('CONFIRMED','REJECTED')
  `, [medicalOrderId]);
  if (pending.rows[0]!.count > 0) throw new Error("MEDICAL_ORDER_ITEMS_PENDING");
  const reviewedOrder = await query<{ version: number }>(client, `
    UPDATE medical_orders SET status='REVIEWED', reviewed_by_user_id=current_app_actor_id(),
      reviewed_at=now(), version=version+1, updated_at=now()
    WHERE id=$1 AND version=$2 AND status='REVIEW_REQUIRED' RETURNING version
  `, [medicalOrderId, expectedVersion]);
  await client.query(`
    INSERT INTO medical_order_review_events
      (tenant_id, medical_order_id, action, actor_id, correlation_id, idempotency_key)
    VALUES (current_app_tenant_id(), $1, 'REVIEW_COMPLETED', current_app_actor_id(),
      current_setting('app.correlation_id'), $2)
  `, [medicalOrderId, `medical-review-completed:${medicalOrderId}`]);
  return { id: medicalOrderId, status: "REVIEWED", version: reviewedOrder.rows[0]!.version };
}

export async function markMedicalOrderUnreadable(
  client: TenantQueryClient,
  medicalOrderId: string,
  expectedOrderVersion: number,
  expectedCaseVersion: number,
  reason: string,
): Promise<MedicalOrderResult> {
  const failureCode = reason.trim();
  if (failureCode.length < 1 || failureCode.length > 200) throw new Error("INVALID_UNREADABLE_REASON");
  const order = await query<{ service_case_id: string; conversation_id: string; status: string; version: number;
    failure_code: string | null }>(client, `
    SELECT medical.service_case_id, medical.conversation_id, medical.status, medical.version, medical.failure_code
    FROM medical_orders medical WHERE medical.id=$1 AND EXISTS (SELECT 1 FROM user_units membership
      WHERE membership.tenant_id=medical.tenant_id AND membership.unit_id=medical.unit_id
        AND membership.user_id=current_app_actor_id() AND membership.status='ACTIVE') FOR UPDATE
  `, [medicalOrderId]);
  if (order.rowCount === 1 && order.rows[0]!.status === "UNREADABLE") {
    if (order.rows[0]!.failure_code !== failureCode) throw new Error("MEDICAL_ORDER_UNREADABLE_CONFLICT");
    return { id: medicalOrderId, status: "UNREADABLE", version: order.rows[0]!.version };
  }
  if (order.rowCount !== 1 || !["PROCESSING", "REVIEW_REQUIRED"].includes(order.rows[0]!.status)
    || order.rows[0]!.version !== expectedOrderVersion) throw new Error("MEDICAL_ORDER_UNREADABLE_CONFLICT");
  const marked = await query<{ version: number }>(client, `
    UPDATE medical_orders SET status='UNREADABLE', failure_code=$1,
      version=version+1, updated_at=now()
    WHERE id=$2 AND version=$3 AND status IN ('PROCESSING','REVIEW_REQUIRED')
    RETURNING version
  `, [failureCode, medicalOrderId, expectedOrderVersion]);
  await ensureMedicalOrderHandoff(client, {
    conversationId: order.rows[0]!.conversation_id,
    serviceCaseId: order.rows[0]!.service_case_id,
    expectedCaseVersion,
    reason: "DOCUMENT_UNREADABLE",
    priority: "HIGH",
    idempotencyKey: `medical-order-unreadable:${medicalOrderId}`,
  });
  await client.query(`
    INSERT INTO medical_order_review_events
      (tenant_id, medical_order_id, action, actor_id, correlation_id, idempotency_key, metadata)
    VALUES (current_app_tenant_id(), $1, 'MARKED_UNREADABLE', current_app_actor_id(),
      current_setting('app.correlation_id'), $3, jsonb_build_object('reason', $2::text))
  `, [medicalOrderId, failureCode, `medical-unreadable:${medicalOrderId}`]);
  return { id: medicalOrderId, status: "UNREADABLE", version: marked.rows[0]!.version };
}
