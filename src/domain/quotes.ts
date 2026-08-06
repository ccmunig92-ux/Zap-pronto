import type { TenantQueryClient } from "../database/tenant-transaction.js";
import { createHash } from "node:crypto";

interface QueryResult<Row> { readonly rowCount: number | null; readonly rows: readonly Row[] }
async function query<Row>(client: TenantQueryClient, text: string, values: unknown[]): Promise<QueryResult<Row>> {
  return await client.query(text, values) as QueryResult<Row>;
}

export interface QuoteItemInput { readonly catalogItemId: string; readonly quantity: number }
export interface CreateQuoteInput {
  readonly serviceCaseId: string;
  readonly priceListVersionId: string;
  readonly items: readonly QuoteItemInput[];
  readonly discountMinor: bigint;
  readonly validUntil: Date;
  readonly idempotencyKey: string;
  readonly requiresHumanReview?: boolean;
}
export interface QuoteCommandInput {
  readonly quoteId: string;
  readonly expectedVersion: number;
}
export interface QuoteResult {
  readonly id: string;
  readonly status: "REVIEW_REQUIRED" | "READY" | "SENT" | "ACCEPTED" | "DECLINED" | "EXPIRED" | "CANCELLED";
  readonly version: number;
  readonly subtotalMinor: bigint;
  readonly discountMinor: bigint;
  readonly totalMinor: bigint;
}

function validKey(value: string): string {
  const key = value.trim();
  if (key.length < 1 || key.length > 200) throw new Error("INVALID_IDEMPOTENCY_KEY");
  return key;
}
function quoteResult(row: Record<string, unknown>): QuoteResult {
  return {
    id: String(row.id), status: row.status as QuoteResult["status"], version: Number(row.version),
    subtotalMinor: BigInt(String(row.subtotal_minor)), discountMinor: BigInt(String(row.discount_minor)),
    totalMinor: BigInt(String(row.total_minor)),
  };
}

export async function createReadyQuote(client: TenantQueryClient, input: CreateQuoteInput): Promise<QuoteResult> {
  const key = validKey(input.idempotencyKey);
  if (input.items.length < 1 || input.items.length > 100) throw new Error("INVALID_QUOTE_ITEMS");
  if (input.discountMinor < 0n) throw new Error("INVALID_DISCOUNT");
  if (!(input.validUntil instanceof Date) || !Number.isFinite(input.validUntil.getTime())
    || input.validUntil.getTime() <= Date.now()) throw new Error("INVALID_QUOTE_VALIDITY");
  for (const item of input.items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) throw new Error("INVALID_QUANTITY");
  }
  if (new Set(input.items.map((item) => item.catalogItemId)).size !== input.items.length) {
    throw new Error("DUPLICATE_CATALOG_ITEM");
  }
  const fingerprint = createHash("sha256").update(JSON.stringify({
    serviceCaseId: input.serviceCaseId,
    priceListVersionId: input.priceListVersionId,
    items: input.items,
    discountMinor: input.discountMinor.toString(),
    validUntil: input.validUntil.toISOString(),
    requiresHumanReview: input.requiresHumanReview === true,
  })).digest("hex");

  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended(current_app_tenant_id()::text || ':' || $1, 0))",
    [key],
  );
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.serviceCaseId]);

  const existing = await query<Record<string, unknown>>(client, `
    SELECT id, status, version, subtotal_minor, discount_minor, total_minor,
      service_case_id, price_list_version_id, request_fingerprint
    FROM quotes WHERE idempotency_key = $1
  `, [key]);
  if (existing.rowCount === 1) {
    const row = existing.rows[0]!;
    if (row.service_case_id !== input.serviceCaseId || row.price_list_version_id !== input.priceListVersionId
      || row.request_fingerprint !== fingerprint) {
      throw new Error("IDEMPOTENCY_KEY_REUSED");
    }
    return quoteResult(row);
  }

  const context = await query<{
    conversation_id: string; unit_id: string; price_list_id: string;
  }>(client, `
    SELECT sc.conversation_id, sc.unit_id, pl.id AS price_list_id
    FROM service_cases sc
    JOIN price_list_versions version ON version.id = $2 AND version.status = 'PUBLISHED'
    JOIN price_lists pl ON pl.tenant_id = version.tenant_id AND pl.id = version.price_list_id
      AND pl.unit_id = sc.unit_id
    WHERE sc.id = $1 AND sc.unit_id IS NOT NULL
    FOR SHARE OF sc, version, pl
  `, [input.serviceCaseId, input.priceListVersionId]);
  if (context.rowCount !== 1) throw new Error("QUOTE_CONTEXT_NOT_FOUND");
  const scope = context.rows[0]!;
  const revisionResult = await query<{ revision: number; supersedes_quote_id: string | null }>(client, `
    SELECT COALESCE(max(revision), 0)::integer + 1 AS revision,
      (array_agg(id ORDER BY revision DESC))[1] AS supersedes_quote_id
    FROM quotes WHERE service_case_id = $1
  `, [input.serviceCaseId]);
  const revision = revisionResult.rows[0]!.revision;
  const supersedesQuoteId = revisionResult.rows[0]!.supersedes_quote_id;

  const catalogIds = input.items.map((item) => item.catalogItemId);
  const priced = await query<{
    catalog_item_id: string; code: string; name: string; amount_minor: string; effective_at: Date;
  }>(client, `
    SELECT price.catalog_item_id, item.code, item.name, price.amount_minor::text, version.effective_at
    FROM prices price
    JOIN catalog_items item ON item.tenant_id = price.tenant_id AND item.id = price.catalog_item_id AND item.active
    JOIN price_list_versions version ON version.tenant_id = price.tenant_id
      AND version.id = price.price_list_version_id AND version.status = 'PUBLISHED'
    WHERE price.price_list_version_id = $1 AND price.catalog_item_id = ANY($2::uuid[])
  `, [input.priceListVersionId, catalogIds]);
  if (priced.rowCount !== input.items.length) throw new Error("PRICE_NOT_FOUND");
  const byCatalog = new Map(priced.rows.map((row) => [row.catalog_item_id, row]));
  let subtotal = 0n;
  const snapshots = input.items.map((item, index) => {
    const price = byCatalog.get(item.catalogItemId);
    if (!price) throw new Error("PRICE_NOT_FOUND");
    const unitPrice = BigInt(price.amount_minor);
    const lineTotal = unitPrice * BigInt(item.quantity);
    if (lineTotal > 9_223_372_036_854_775_807n) throw new Error("QUOTE_AMOUNT_OVERFLOW");
    subtotal += lineTotal;
    if (subtotal > 9_223_372_036_854_775_807n) throw new Error("QUOTE_AMOUNT_OVERFLOW");
    return { ...item, lineNumber: index + 1, price, unitPrice };
  });
  if (input.discountMinor > subtotal) throw new Error("INVALID_DISCOUNT");

  const created = await query<{ id: string }>(client, `
    INSERT INTO quotes
      (tenant_id, service_case_id, conversation_id, unit_id, price_list_id, price_list_version_id,
       revision, supersedes_quote_id, status, subtotal_minor, discount_minor, total_minor,
       valid_until, prepared_by_user_id, idempotency_key, request_fingerprint)
    VALUES (current_app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, 'DRAFT', 0, 0, 0, $8,
      current_app_actor_id(), $9, $10)
    RETURNING id
  `, [input.serviceCaseId, scope.conversation_id, scope.unit_id, scope.price_list_id,
    input.priceListVersionId, revision, supersedesQuoteId, input.validUntil, key, fingerprint]);
  const quoteId = created.rows[0]!.id;

  for (const snapshot of snapshots) {
    await client.query(`
      INSERT INTO quote_items
        (tenant_id, quote_id, line_number, catalog_item_id, price_list_version_id,
         catalog_code_snapshot, description_snapshot, quantity, unit_price_minor, line_total_minor, price_effective_at)
      SELECT current_app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, version.effective_at
      FROM price_list_versions version WHERE version.id = $4
    `, [quoteId, snapshot.lineNumber, snapshot.catalogItemId, input.priceListVersionId,
      snapshot.price.code, snapshot.price.name, snapshot.quantity, snapshot.unitPrice.toString(),
      (snapshot.unitPrice * BigInt(snapshot.quantity)).toString()]);
  }

  const targetStatus = input.requiresHumanReview === true ? "REVIEW_REQUIRED" : "READY";
  const ready = await query<Record<string, unknown>>(client, `
    UPDATE quotes SET status = $4, subtotal_minor = $1, discount_minor = $2, total_minor = $1::bigint - $2::bigint,
      version = version + 1, updated_at = now()
    WHERE id = $3 AND status = 'DRAFT'
    RETURNING id, status, version, subtotal_minor, discount_minor, total_minor
  `, [subtotal.toString(), input.discountMinor.toString(), quoteId, targetStatus]);
  if (ready.rowCount !== 1) throw new Error("QUOTE_CREATION_FAILED");
  return quoteResult(ready.rows[0]!);
}

async function transitionQuote(
  client: TenantQueryClient,
  input: QuoteCommandInput,
  transition: "SENT" | "ACCEPTED",
): Promise<QuoteResult> {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw new Error("INVALID_EXPECTED_VERSION");
  const from = transition === "SENT" ? "READY" : "SENT";
  const timestamp = transition === "SENT" ? "sent_at" : "accepted_at";
  const updated = await query<Record<string, unknown>>(client, `
    UPDATE quotes SET status = $1, ${timestamp} = now(), version = version + 1, updated_at = now()
    WHERE id = $2 AND version = $3 AND status = $4 AND valid_until > clock_timestamp()
    RETURNING id, status, version, subtotal_minor, discount_minor, total_minor
  `, [transition, input.quoteId, input.expectedVersion, from]);
  if (updated.rowCount !== 1) {
    const replay = await query<Record<string, unknown>>(client, `
      SELECT id, status, version, subtotal_minor, discount_minor, total_minor
      FROM quotes WHERE id = $1
    `, [input.quoteId]);
    const current = replay.rows[0];
    const wasSent = transition === "SENT" && current
      && ["SENT", "ACCEPTED", "DECLINED", "EXPIRED"].includes(String(current.status));
    const wasAccepted = transition === "ACCEPTED" && current?.status === "ACCEPTED";
    if (wasSent || wasAccepted) return quoteResult(current!);
    throw new Error("QUOTE_TRANSITION_CONFLICT");
  }
  return quoteResult(updated.rows[0]!);
}

export const sendQuote = (client: TenantQueryClient, input: QuoteCommandInput) =>
  transitionQuote(client, input, "SENT");
export const acceptQuote = (client: TenantQueryClient, input: QuoteCommandInput) =>
  transitionQuote(client, input, "ACCEPTED");

export async function publishPriceListVersion(
  client: TenantQueryClient,
  priceListVersionId: string,
): Promise<void> {
  let version = await query<{ price_list_id: string; status: string }>(client, `
    SELECT price_list_id, status FROM price_list_versions WHERE id = $1
  `, [priceListVersionId]);
  if (version.rowCount === 1 && ["PUBLISHED", "RETIRED"].includes(String(version.rows[0]!.status))) return;
  if (version.rowCount !== 1 || version.rows[0]!.status !== "DRAFT") {
    throw new Error("PRICE_VERSION_NOT_DRAFT");
  }
  const priceListId = version.rows[0]!.price_list_id;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`price-list:${priceListId}`]);
  version = await query<{ price_list_id: string; status: string }>(client, `
    SELECT price_list_id, status FROM price_list_versions WHERE id = $1 FOR UPDATE
  `, [priceListVersionId]);
  if (version.rowCount === 1 && ["PUBLISHED", "RETIRED"].includes(String(version.rows[0]!.status))) return;
  if (version.rowCount !== 1 || version.rows[0]!.status !== "DRAFT") {
    throw new Error("PRICE_VERSION_NOT_DRAFT");
  }
  const prices = await query<{ count: number }>(client, `
    SELECT count(*)::integer AS count FROM prices WHERE price_list_version_id = $1
  `, [priceListVersionId]);
  if (prices.rows[0]!.count < 1) throw new Error("PRICE_VERSION_EMPTY");
  await client.query(`
    UPDATE price_list_versions SET status = 'RETIRED', retired_at = now()
    WHERE price_list_id = $1 AND status = 'PUBLISHED'
  `, [priceListId]);
  const published = await query<{ id: string }>(client, `
    UPDATE price_list_versions SET status = 'PUBLISHED', published_at = now()
    WHERE id = $1 AND status = 'DRAFT'
    RETURNING id
  `, [priceListVersionId]);
  if (published.rowCount !== 1) throw new Error("PRICE_VERSION_PUBLISH_CONFLICT");
  await client.query(`
    INSERT INTO outbox_events
      (tenant_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key)
    VALUES (current_app_tenant_id(), 'price_list_version', $1, 'price_list_version.published',
      jsonb_build_object('priceListVersionId', $1::uuid), 'price.published:' || $1::text)
  `, [priceListVersionId]);
}

export async function approveQuoteReview(client: TenantQueryClient, input: QuoteCommandInput): Promise<QuoteResult> {
  const approved = await query<Record<string, unknown>>(client, `
    UPDATE quotes SET status = 'READY', reviewed_by_user_id = current_app_actor_id(),
      reviewed_at = now(), version = version + 1, updated_at = now()
    WHERE id = $1 AND version = $2 AND status = 'REVIEW_REQUIRED'
    RETURNING id, status, version, subtotal_minor, discount_minor, total_minor
  `, [input.quoteId, input.expectedVersion]);
  if (approved.rowCount !== 1) throw new Error("QUOTE_TRANSITION_CONFLICT");
  return quoteResult(approved.rows[0]!);
}

export async function declineQuote(client: TenantQueryClient, input: QuoteCommandInput): Promise<QuoteResult> {
  return finishQuote(client, input, "DECLINED", "declined_at", "status = 'SENT'");
}

export async function expireQuote(client: TenantQueryClient, input: QuoteCommandInput): Promise<QuoteResult> {
  return finishQuote(client, input, "EXPIRED", "expired_at", "status = 'SENT' AND valid_until <= clock_timestamp()");
}

export async function cancelQuote(client: TenantQueryClient, input: QuoteCommandInput): Promise<QuoteResult> {
  return finishQuote(
    client, input, "CANCELLED", "cancelled_at",
    "status IN ('DRAFT', 'REVIEW_REQUIRED', 'READY', 'SENT')",
  );
}

async function finishQuote(
  client: TenantQueryClient,
  input: QuoteCommandInput,
  target: "DECLINED" | "EXPIRED" | "CANCELLED",
  timestampColumn: "declined_at" | "expired_at" | "cancelled_at",
  statePredicate: string,
): Promise<QuoteResult> {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw new Error("INVALID_EXPECTED_VERSION");
  const result = await query<Record<string, unknown>>(client, `
    UPDATE quotes SET status = $1, ${timestampColumn} = now(), version = version + 1, updated_at = now()
    WHERE id = $2 AND version = $3 AND ${statePredicate}
    RETURNING id, status, version, subtotal_minor, discount_minor, total_minor
  `, [target, input.quoteId, input.expectedVersion]);
  if (result.rowCount !== 1) {
    const replay = await query<Record<string, unknown>>(client, `
      SELECT id, status, version, subtotal_minor, discount_minor, total_minor FROM quotes WHERE id = $1
    `, [input.quoteId]);
    if (replay.rows[0]?.status === target) return quoteResult(replay.rows[0]!);
    throw new Error("QUOTE_TRANSITION_CONFLICT");
  }
  return quoteResult(result.rows[0]!);
}
