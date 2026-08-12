import type { FastifyInstance } from "fastify";
import {
  DEFAULT_META_WEBHOOK_MAX_BODY_BYTES,
  verifyMetaWebhookSignature,
} from "@zap-pronto/core/domain/meta-webhook-signature";

export interface MetaSignedJsonBoundaryOptions {
  readonly appSecret: string;
  readonly maxBodyBytes?: number;
  readonly registerRoutes: (scope: FastifyInstance) => void | Promise<void>;
}

export class MetaSignedJsonError extends Error {
  constructor(readonly statusCode: 400 | 401 | 415 | 503, readonly code:
    "META_WEBHOOK_INVALID_JSON" | "META_WEBHOOK_REJECTED" | "META_WEBHOOK_INVALID_CALLBACK" |
    "META_WEBHOOK_UNSUPPORTED_MEDIA_TYPE" | "META_WEBHOOK_UNAVAILABLE") {
    super(code);
    this.name = "MetaSignedJsonError";
  }
}

function uniqueRawHeader(rawHeaders: readonly string[], expectedName: string): string | undefined {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === expectedName) values.push(rawHeaders[index + 1] ?? "");
  }
  return values.length === 1 ? values[0] : undefined;
}

/** Encapsulated boundary for future Meta routes; it does not register a public endpoint by itself. */
export async function registerMetaSignedJsonBoundary(
  parent: FastifyInstance,
  options: MetaSignedJsonBoundaryOptions,
): Promise<void> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_META_WEBHOOK_MAX_BODY_BYTES;
  if (typeof options.appSecret !== "string" || options.appSecret.length === 0
    || Buffer.byteLength(options.appSecret, "utf8") > 4096
    || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1
    || maxBodyBytes > DEFAULT_META_WEBHOOK_MAX_BODY_BYTES) {
    throw new Error("META_WEBHOOK_CONFIGURATION_INVALID");
  }
  await parent.register(async (scope) => {
    scope.setErrorHandler((error, request, reply) => {
      const fastifyCode = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      const status = error instanceof MetaSignedJsonError ? error.statusCode
        : fastifyCode === "FST_ERR_CTP_INVALID_MEDIA_TYPE" ? 415
          : fastifyCode === "FST_ERR_CTP_BODY_TOO_LARGE" ? 413 : 503;
      const code = error instanceof MetaSignedJsonError ? error.code
        : status === 415 ? "META_WEBHOOK_UNSUPPORTED_MEDIA_TYPE"
          : status === 413 ? "META_WEBHOOK_BODY_TOO_LARGE" : "META_WEBHOOK_UNAVAILABLE";
      void reply.header("cache-control", "no-store").status(status).type("application/problem+json").send({
        type: `urn:zap-pronto:error:${code.toLowerCase().replaceAll("_", "-")}`,
        title: status === 400 ? "Bad Request" : status === 401 ? "Unauthorized"
          : status === 413 ? "Payload Too Large" : status === 415 ? "Unsupported Media Type" : "Service Unavailable",
        status, detail: "Meta webhook request rejected", correlationId: request.id,
      });
    });
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: maxBodyBytes },
      (_request, body, done) => done(null, body));
    scope.addHook("onRequest", async (request) => {
      const contentType=uniqueRawHeader(request.raw.rawHeaders,"content-type");
      if(!contentType||contentType.split(";",1)[0]?.trim().toLowerCase()!=="application/json"){
        throw new MetaSignedJsonError(415,"META_WEBHOOK_UNSUPPORTED_MEDIA_TYPE");
      }
    });
    scope.addHook("preValidation", async (request) => {
      const signatureHeader = uniqueRawHeader(request.raw.rawHeaders, "x-hub-signature-256");
      const rawBody = request.body;
      if (!(rawBody instanceof Uint8Array) || !verifyMetaWebhookSignature({
        appSecret: options.appSecret, rawBody, signatureHeader, maxBodyBytes,
      })) throw new MetaSignedJsonError(401, "META_WEBHOOK_REJECTED");
      try {
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
        request.body = JSON.parse(decoded) as unknown;
      } catch {
        throw new MetaSignedJsonError(400, "META_WEBHOOK_INVALID_JSON");
      }
    });
    scope.addHook("onSend", async (_request, reply, payload) => {
      reply.header("cache-control", "no-store");
      return payload;
    });
    await options.registerRoutes(scope);
  });
}
