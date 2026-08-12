import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  acceptInboundEnvelope,
  canHermesHandleInbound,
  inboundIdempotencyKey,
  normalizeWhatsAppInbound,
  validateInboundEnvelope,
} from "./channel-inbound.js";

const whatsappFixture = {
  entry: [{ changes: [{ value: {
    metadata: { phone_number_id: "wa-account-1" },
    messages: [{ id: "wamid.synthetic-1", from: "5521999990000", timestamp: "1786381200",
      type: "text", text: { body: "Olá" } }],
  } }] }],
};

function envelope() {
  return normalizeWhatsAppInbound(whatsappFixture)[0]!;
}

describe("inbound multicanal", () => {
  it("normaliza WhatsApp sintético sem aceitar tenant ou unidade do payload", () => {
    const normalized = envelope();
    assert.deepEqual(normalized, {
      provider: "META_WHATSAPP", channel: "WHATSAPP", providerEventId: "wamid.synthetic-1",
      channelAccountId: "wa-account-1", senderExternalId: "5521999990000",
      recipientExternalId: "wa-account-1", occurredAt: "2026-08-10T17:00:00.000Z",
      kind: "TEXT", payload: { text: "Olá" },
    });
    assert.equal("tenantId" in normalized, false);
    assert.equal("unitId" in normalized, false);
  });

  it("rejeita payload inválido e combinação provider/canal incoerente", () => {
    assert.throws(() => normalizeWhatsAppInbound({ entry: [] }), /INVALID_WHATSAPP_PAYLOAD/);
    assert.throws(() => validateInboundEnvelope({ ...envelope(), channel: "INSTAGRAM" }),
      /INVALID_INBOUND_PROVIDER_CHANNEL/);
    assert.throws(() => validateInboundEnvelope({ ...envelope(), payload: { text: "" } }), /INVALID_INBOUND_TEXT/);
    assert.throws(() => validateInboundEnvelope({ ...envelope(), tenantId: "attacker" }), /INVALID_INBOUND_ENVELOPE/);
  });

  it("marca áudio e documento como conteúdo não confiável", () => {
    const messages = [
      { id: "wamid.audio", from: "sender", timestamp: "1786381200", type: "audio",
        audio: { id: "media-audio", mime_type: "audio/ogg" } },
      { id: "wamid.document", from: "sender", timestamp: "1786381201", type: "document",
        document: { id: "media-document", mime_type: "application/pdf", filename: "pedido.pdf" } },
    ];
    const normalized = normalizeWhatsAppInbound({ entry: [{ changes: [{ value: {
      metadata: { phone_number_id: "wa-account-1" }, messages,
    } }] }] });
    assert.deepEqual(normalized.map((item) => [item.kind, "trust" in item.payload ? item.payload.trust : null]),
      [["AUDIO", "UNTRUSTED"], ["DOCUMENT", "UNTRUSTED"]]);
    assert.throws(() => validateInboundEnvelope({ ...normalized[0],
      payload: { ...normalized[0]!.payload, trust: "TRUSTED" } }), /INBOUND_CONTENT_MUST_BE_UNTRUSTED/);
  });

  it("deriva chave estável do provider, evento e conta", () => {
    const original = envelope();
    const changedPayload = { ...original, payload: { text: "alterado" } };
    assert.equal(inboundIdempotencyKey(original), inboundIdempotencyKey(changedPayload));
    assert.notEqual(inboundIdempotencyKey(original), inboundIdempotencyKey({ ...original, providerEventId: "other" }));
  });

  it("reproduz duplicata e rejeita fingerprint divergente", async () => {
    let storedFingerprint: string | undefined;
    const pool = { connect: async () => ({ release() {}, query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("resolve_inbound_channel_binding")) return { rowCount: 1, rows: [{
        tenantId: "tenant-a", unitId: "unit-a", channelConnectionId: "connection-a",
        routingStatus: "ROUTED", routingReason: null,
      }] };
      if (sql.includes("persist_inbound_channel_event")) {
        const fingerprint = String(values[9]);
        if (storedFingerprint && storedFingerprint !== fingerprint) throw new Error("INBOUND_IDEMPOTENCY_COLLISION");
        const replayed = storedFingerprint !== undefined;
        storedFingerprint = fingerprint;
        return { rowCount: 1, rows: [{ id: "event-a", tenantId: "tenant-a", unitId: "unit-a",
          channelConnectionId: "connection-a", routingStatus: "ROUTED", routingReason: null, replayed }] };
      }
      return { rowCount: null, rows: [] };
    } }) };
    const first = await acceptInboundEnvelope(pool, envelope(), "inbound-test-first");
    const replay = await acceptInboundEnvelope(pool, envelope(), "inbound-test-replay");
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    await assert.rejects(acceptInboundEnvelope(pool, { ...envelope(), payload: { text: "divergente" } },
      "inbound-test-collision"),
      /INBOUND_IDEMPOTENCY_COLLISION/);
  });

  it("falha fechado quando a resolução server-side não retorna binding", async () => {
    const invisible = { connect: async () => ({ release() {}, query: async (sql: string) =>
      sql.includes("resolve_inbound_channel_binding") ? { rowCount: 0, rows: [] } : { rowCount: null, rows: [] } }) };
    await assert.rejects(acceptInboundEnvelope(invisible, envelope(), "inbound-not-routable"),
      /CHANNEL_ACCOUNT_NOT_ROUTABLE/);
  });

  it("mantém Hermes bloqueado durante HUMAN_QUEUED e HUMAN_ACTIVE", () => {
    assert.equal(canHermesHandleInbound("ACTIVE"), true);
    assert.equal(canHermesHandleInbound("HUMAN_QUEUED"), false);
    assert.equal(canHermesHandleInbound("HUMAN_ACTIVE"), false);
  });
});
