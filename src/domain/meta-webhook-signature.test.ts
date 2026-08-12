import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  DEFAULT_META_WEBHOOK_MAX_BODY_BYTES,
  verifyMetaWebhookSignature,
} from "./meta-webhook-signature.js";

const secret = "synthetic-meta-app-secret";
const rawBody = Buffer.from('{"entry":[{"id":"synthetic"}]}', "utf8");
const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

describe("Meta webhook signature", () => {
  it("aceita vetor HMAC-SHA256 válido sobre os bytes exatos", () => {
    assert.equal(verifyMetaWebhookSignature({ appSecret: secret, rawBody, signatureHeader: signature }), true);
    assert.equal(verifyMetaWebhookSignature({ appSecret: secret, rawBody: new Uint8Array(rawBody),
      signatureHeader: signature }), true);
  });

  it("rejeita qualquer alteração ou reserialização do raw body", () => {
    const whitespaceChanged = Buffer.from('{"entry": [{"id":"synthetic"}]}', "utf8");
    assert.equal(verifyMetaWebhookSignature({ appSecret: secret, rawBody: whitespaceChanged,
      signatureHeader: signature }), false);
    const tampered = Buffer.from(rawBody);
    const tamperedIndex = tampered.length - 2;
    tampered[tamperedIndex] = (tampered[tamperedIndex] ?? 0) ^ 1;
    assert.equal(verifyMetaWebhookSignature({ appSecret: secret, rawBody: tampered, signatureHeader: signature }), false);
  });

  it("rejeita header ausente, algoritmo diferente, formato ambíguo e hexadecimal inválido", () => {
    for (const signatureHeader of [undefined, "", "sha1=" + "0".repeat(64), "sha256=deadbeef",
      "sha256=" + "G".repeat(64), signature + "=extra", signature.toUpperCase()]) {
      assert.equal(verifyMetaWebhookSignature({ appSecret: secret, rawBody, signatureHeader }), false);
    }
  });

  it("aplica limite de corpo antes do HMAC e rejeita configuração insegura", () => {
    const boundaryBody = Buffer.alloc(32, 0x61);
    const boundarySignature = `sha256=${createHmac("sha256", secret).update(boundaryBody).digest("hex")}`;
    assert.equal(verifyMetaWebhookSignature({ appSecret: secret, rawBody: boundaryBody,
      signatureHeader: boundarySignature, maxBodyBytes: 32 }), true);
    assert.equal(verifyMetaWebhookSignature({ appSecret: secret, rawBody: boundaryBody,
      signatureHeader: boundarySignature, maxBodyBytes: 31 }), false);
    assert.equal(verifyMetaWebhookSignature({ appSecret: secret, rawBody,
      signatureHeader: signature, maxBodyBytes: 0 }), false);
    assert.equal(verifyMetaWebhookSignature({ appSecret: secret, rawBody,
      signatureHeader: signature, maxBodyBytes: DEFAULT_META_WEBHOOK_MAX_BODY_BYTES + 16 * 1024 * 1024 }), false);
    assert.equal(verifyMetaWebhookSignature({ appSecret: "", rawBody, signatureHeader: signature }), false);
  });
});
