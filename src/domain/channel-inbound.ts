import { createHash } from "node:crypto";
import type { TenantTransactionPool } from "../database/tenant-transaction.js";
import type {
  AutomationStatus,
  ChannelInboundAdapter,
  InboundChannel,
  InboundContentKind,
  InboundEnvelope,
  InboundProvider,
} from "./contracts.js";
import { canAutomationReply } from "./invariants.js";

interface QueryResult<Row> { readonly rowCount: number | null; readonly rows: readonly Row[] }
type UnknownRecord = Record<string, unknown>;

const PROVIDER_CHANNEL: Readonly<Record<InboundProvider, InboundChannel>> = {
  META_WHATSAPP: "WHATSAPP",
  META_INSTAGRAM: "INSTAGRAM",
  META_FACEBOOK: "FACEBOOK",
};
const KINDS: ReadonlySet<InboundContentKind> = new Set(["TEXT", "AUDIO", "IMAGE", "DOCUMENT", "INTERACTIVE"]);
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function record(value: unknown, code = "INVALID_INBOUND_PAYLOAD"): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(code);
  return value as UnknownRecord;
}

function text(value: unknown, code: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) throw new Error(code);
  return normalized;
}

function optionalText(value: unknown, code: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : text(value, code, maxLength);
}

function exactKeys(value: UnknownRecord, keys: readonly string[], code: string): void {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new Error(code);
}

function mediaPayload(kind: "AUDIO" | "IMAGE" | "DOCUMENT", raw: UnknownRecord): InboundEnvelope["payload"] {
  const mediaId = text(raw.mediaId, "INVALID_INBOUND_MEDIA_ID", 512);
  const mimeType = optionalText(raw.mimeType, "INVALID_INBOUND_MIME_TYPE", 255);
  if (raw.trust !== "UNTRUSTED") throw new Error("INBOUND_CONTENT_MUST_BE_UNTRUSTED");
  if (kind === "AUDIO") {
    exactKeys(raw, ["mediaId", ...(mimeType ? ["mimeType"] : []), "trust"], "INVALID_INBOUND_PAYLOAD");
    return { mediaId, ...(mimeType ? { mimeType } : {}), trust: "UNTRUSTED" };
  }
  const caption = optionalText(raw.caption, "INVALID_INBOUND_CAPTION", 4096);
  if (kind === "IMAGE") {
    exactKeys(raw, ["mediaId", ...(mimeType ? ["mimeType"] : []), ...(caption ? ["caption"] : []), "trust"],
      "INVALID_INBOUND_PAYLOAD");
    return { mediaId, ...(mimeType ? { mimeType } : {}), ...(caption ? { caption } : {}), trust: "UNTRUSTED" };
  }
  const fileName = optionalText(raw.fileName, "INVALID_INBOUND_FILE_NAME", 512);
  exactKeys(raw, ["mediaId", ...(mimeType ? ["mimeType"] : []), ...(fileName ? ["fileName"] : []),
    ...(caption ? ["caption"] : []), "trust"], "INVALID_INBOUND_PAYLOAD");
  return { mediaId, ...(mimeType ? { mimeType } : {}), ...(fileName ? { fileName } : {}),
    ...(caption ? { caption } : {}), trust: "UNTRUSTED" };
}

export function validateInboundEnvelope(value: unknown): InboundEnvelope {
  const envelope = record(value, "INVALID_INBOUND_ENVELOPE");
  const provider = text(envelope.provider, "INVALID_INBOUND_PROVIDER", 64) as InboundProvider;
  const channel = text(envelope.channel, "INVALID_INBOUND_CHANNEL", 32) as InboundChannel;
  if (!(provider in PROVIDER_CHANNEL) || PROVIDER_CHANNEL[provider] !== channel) throw new Error("INVALID_INBOUND_PROVIDER_CHANNEL");
  const kind = text(envelope.kind, "INVALID_INBOUND_KIND", 32) as InboundContentKind;
  if (!KINDS.has(kind)) throw new Error("INVALID_INBOUND_KIND");
  const providerEventId = text(envelope.providerEventId, "INVALID_PROVIDER_EVENT_ID", 512);
  const channelAccountId = text(envelope.channelAccountId, "INVALID_CHANNEL_ACCOUNT_ID", 512);
  const senderExternalId = text(envelope.senderExternalId, "INVALID_SENDER_EXTERNAL_ID", 512);
  const recipientExternalId = text(envelope.recipientExternalId, "INVALID_RECIPIENT_EXTERNAL_ID", 512);
  const occurredAt = text(envelope.occurredAt, "INVALID_INBOUND_OCCURRED_AT", 64);
  if (!ISO_INSTANT.test(occurredAt) || new Date(occurredAt).toISOString() !== occurredAt) {
    throw new Error("INVALID_INBOUND_OCCURRED_AT");
  }
  exactKeys(envelope, ["provider", "channel", "providerEventId", "channelAccountId", "senderExternalId",
    "recipientExternalId", "occurredAt", "kind", "payload"], "INVALID_INBOUND_ENVELOPE");
  const rawPayload = record(envelope.payload);
  let payload: InboundEnvelope["payload"];
  if (kind === "TEXT") {
    exactKeys(rawPayload, ["text"], "INVALID_INBOUND_PAYLOAD");
    payload = { text: text(rawPayload.text, "INVALID_INBOUND_TEXT", 32_000) };
  } else if (kind === "INTERACTIVE") {
    const interactionId = text(rawPayload.interactionId, "INVALID_INBOUND_INTERACTION_ID", 512);
    const title = optionalText(rawPayload.title, "INVALID_INBOUND_INTERACTION_TITLE", 512);
    if (rawPayload.trust !== "UNTRUSTED") throw new Error("INBOUND_CONTENT_MUST_BE_UNTRUSTED");
    exactKeys(rawPayload, ["interactionId", ...(title ? ["title"] : []), "trust"], "INVALID_INBOUND_PAYLOAD");
    payload = { interactionId, ...(title ? { title } : {}), trust: "UNTRUSTED" };
  } else {
    payload = mediaPayload(kind, rawPayload);
  }
  return { provider, channel, providerEventId, channelAccountId, senderExternalId, recipientExternalId,
    occurredAt, kind, payload } as InboundEnvelope;
}

function whatsappContent(message: UnknownRecord): Pick<InboundEnvelope, "kind" | "payload"> {
  const type = text(message.type, "INVALID_WHATSAPP_MESSAGE_TYPE", 32);
  if (type === "text") {
    const body = record(message.text);
    return { kind: "TEXT", payload: { text: text(body.body, "INVALID_INBOUND_TEXT", 32_000) } };
  }
  if (type === "audio" || type === "image" || type === "document") {
    const media = record(message[type]);
    const mediaId = text(media.id, "INVALID_INBOUND_MEDIA_ID", 512);
    const mimeType = optionalText(media.mime_type, "INVALID_INBOUND_MIME_TYPE", 255);
    const base = { mediaId, ...(mimeType ? { mimeType } : {}), trust: "UNTRUSTED" as const };
    if (type === "audio") return { kind: "AUDIO", payload: base };
    const caption = optionalText(media.caption, "INVALID_INBOUND_CAPTION", 4096);
    if (type === "image") return { kind: "IMAGE", payload: { ...base, ...(caption ? { caption } : {}) } };
    const fileName = optionalText(media.filename, "INVALID_INBOUND_FILE_NAME", 512);
    return { kind: "DOCUMENT", payload: { ...base, ...(fileName ? { fileName } : {}), ...(caption ? { caption } : {}) } };
  }
  if (type === "interactive") {
    const interactive = record(message.interactive);
    const reply = record(interactive.button_reply ?? interactive.list_reply);
    const interactionId = text(reply.id, "INVALID_INBOUND_INTERACTION_ID", 512);
    const title = optionalText(reply.title, "INVALID_INBOUND_INTERACTION_TITLE", 512);
    return { kind: "INTERACTIVE", payload: { interactionId, ...(title ? { title } : {}), trust: "UNTRUSTED" } };
  }
  throw new Error("UNSUPPORTED_WHATSAPP_MESSAGE_TYPE");
}

export function normalizeWhatsAppInbound(payload: unknown): readonly InboundEnvelope[] {
  const root = record(payload, "INVALID_WHATSAPP_PAYLOAD");
  if (!Array.isArray(root.entry) || root.entry.length === 0) throw new Error("INVALID_WHATSAPP_PAYLOAD");
  const normalized: InboundEnvelope[] = [];
  for (const rawEntry of root.entry) {
    const entry = record(rawEntry, "INVALID_WHATSAPP_PAYLOAD");
    if (!Array.isArray(entry.changes)) throw new Error("INVALID_WHATSAPP_PAYLOAD");
    for (const rawChange of entry.changes) {
      const change = record(rawChange, "INVALID_WHATSAPP_PAYLOAD");
      const value = record(change.value, "INVALID_WHATSAPP_PAYLOAD");
      const metadata = record(value.metadata, "INVALID_WHATSAPP_PAYLOAD");
      const channelAccountId = text(metadata.phone_number_id, "INVALID_CHANNEL_ACCOUNT_ID", 512);
      if (!Array.isArray(value.messages)) continue;
      for (const rawMessage of value.messages) {
        const message = record(rawMessage, "INVALID_WHATSAPP_PAYLOAD");
        const timestamp = text(message.timestamp, "INVALID_INBOUND_OCCURRED_AT", 32);
        if (!/^\d{1,16}$/.test(timestamp)) throw new Error("INVALID_INBOUND_OCCURRED_AT");
        const occurredAt = new Date(Number(timestamp) * 1000);
        if (!Number.isSafeInteger(Number(timestamp)) || Number.isNaN(occurredAt.valueOf())) throw new Error("INVALID_INBOUND_OCCURRED_AT");
        normalized.push(validateInboundEnvelope({ provider: "META_WHATSAPP", channel: "WHATSAPP",
          providerEventId: text(message.id, "INVALID_PROVIDER_EVENT_ID", 512), channelAccountId,
          senderExternalId: text(message.from, "INVALID_SENDER_EXTERNAL_ID", 512),
          recipientExternalId: channelAccountId, occurredAt: occurredAt.toISOString(), ...whatsappContent(message) }));
      }
    }
  }
  if (normalized.length === 0) throw new Error("WHATSAPP_MESSAGES_REQUIRED");
  return normalized;
}

export const whatsAppInboundAdapter: ChannelInboundAdapter = {
  provider: "META_WHATSAPP",
  channel: "WHATSAPP",
  normalize: normalizeWhatsAppInbound,
};

export function inboundIdempotencyKey(envelope: Pick<InboundEnvelope, "provider" | "providerEventId" | "channelAccountId">): string {
  return `inbound:${createHash("sha256").update(`${envelope.provider}\0${envelope.providerEventId}\0${envelope.channelAccountId}`).digest("hex")}`;
}

function inboundFingerprint(envelope: InboundEnvelope): string {
  return createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
}

export interface AcceptedInboundEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly unitId: string | null;
  readonly channelConnectionId: string;
  readonly routingStatus: "ROUTED" | "UNROUTED";
  readonly routingReason: "MULTIPLE_ACTIVE_UNITS" | null;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly replayed: boolean;
}

export async function acceptInboundEnvelope(
  pool: TenantTransactionPool,
  rawEnvelope: unknown,
  correlationId: string,
): Promise<AcceptedInboundEvent> {
  const envelope = validateInboundEnvelope(rawEnvelope);
  if (correlationId.length < 8 || correlationId.length > 128) throw new Error("INVALID_CORRELATION_ID");
  const idempotencyKey = inboundIdempotencyKey(envelope);
  const fingerprint = inboundFingerprint(envelope);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE zap_pronto_api");
    await client.query("SELECT set_config('app.correlation_id',$1,true)", [correlationId]);
    const resolved = await client.query(`SELECT tenant_id AS "tenantId",
      channel_connection_id AS "channelConnectionId",unit_id AS "unitId",
      routing_status AS "routingStatus",routing_reason AS "routingReason"
      FROM resolve_inbound_channel_binding($1,$2)`, [envelope.provider, envelope.channelAccountId]) as QueryResult<{
      tenantId: string; channelConnectionId: string; unitId: string | null;
      routingStatus: "ROUTED" | "UNROUTED"; routingReason: "MULTIPLE_ACTIVE_UNITS" | null;
    }>;
    if ((resolved.rowCount ?? resolved.rows.length) !== 1) throw new Error("CHANNEL_ACCOUNT_NOT_ROUTABLE");
    const binding = resolved.rows[0]!;
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [binding.tenantId]);
    const persisted = await client.query(`SELECT id,tenant_id AS "tenantId",unit_id AS "unitId",
      channel_connection_id AS "channelConnectionId",routing_status AS "routingStatus",
      routing_reason AS "routingReason",replayed
      FROM persist_inbound_channel_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14)`,
    [envelope.provider, envelope.providerEventId, envelope.channelAccountId, envelope.senderExternalId,
      envelope.recipientExternalId, envelope.occurredAt, envelope.kind, JSON.stringify(envelope.payload),
      idempotencyKey, fingerprint, binding.channelConnectionId, binding.unitId,
      binding.routingStatus, binding.routingReason]) as QueryResult<{
      id: string; tenantId: string; unitId: string | null; channelConnectionId: string;
      routingStatus: "ROUTED" | "UNROUTED"; routingReason: "MULTIPLE_ACTIVE_UNITS" | null; replayed: boolean;
    }>;
    if ((persisted.rowCount ?? persisted.rows.length) !== 1) throw new Error("INBOUND_PERSISTENCE_FAILED");
    await client.query("COMMIT");
    client.release();
    return { ...persisted.rows[0]!, idempotencyKey, fingerprint };
  } catch (error) {
    try { await client.query("ROLLBACK"); client.release(); }
    catch (rollbackError) { client.release(rollbackError instanceof Error ? rollbackError : true); }
    throw error;
  }
}

export function canHermesHandleInbound(status: AutomationStatus): boolean {
  return canAutomationReply(status);
}
