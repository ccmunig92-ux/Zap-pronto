import { createHmac, timingSafeEqual } from "node:crypto";

export const DEFAULT_META_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const ABSOLUTE_META_WEBHOOK_MAX_BODY_BYTES = 16 * 1024 * 1024;
const META_SIGNATURE = /^sha256=([0-9a-f]{64})$/;

export interface VerifyMetaWebhookSignatureInput {
  readonly appSecret: string;
  readonly rawBody: Uint8Array;
  readonly signatureHeader: string | undefined;
  readonly maxBodyBytes?: number;
}

/**
 * Adapted from gokapso/whatsapp-cloud-api-js src/webhooks/verify.ts (MIT).
 * Verifies only the exact raw bytes; parsing or re-serialization must happen later.
 */
export function verifyMetaWebhookSignature(input: VerifyMetaWebhookSignatureInput): boolean {
  try {
    const maxBodyBytes = input.maxBodyBytes ?? DEFAULT_META_WEBHOOK_MAX_BODY_BYTES;
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1
      || maxBodyBytes > ABSOLUTE_META_WEBHOOK_MAX_BODY_BYTES) return false;
    if (typeof input.appSecret !== "string" || input.appSecret.length === 0
      || Buffer.byteLength(input.appSecret, "utf8") > 4096) return false;
    if (!(input.rawBody instanceof Uint8Array) || input.rawBody.byteLength > maxBodyBytes) return false;
    if (typeof input.signatureHeader !== "string") return false;
    const match = META_SIGNATURE.exec(input.signatureHeader);
    if (!match) return false;
    const received = Buffer.from(match[1]!, "hex");
    const expected = createHmac("sha256", input.appSecret).update(input.rawBody).digest();
    return received.byteLength === expected.byteLength && timingSafeEqual(received, expected);
  } catch {
    return false;
  }
}
