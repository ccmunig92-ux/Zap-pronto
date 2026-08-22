import { readFile } from "node:fs/promises";
import type { OutboundTransport, OutboundTransportInput, OutboundTransportResult } from "./outbound-runner.js";

const GRAPH_ORIGIN = "https://graph.facebook.com";
const PHONE_NUMBER_ID = /^\d{6,32}$/;
const RECIPIENT = /^\d{8,15}$/;
const API_VERSION = /^v\d+\.\d+$/;

export interface MetaWhatsAppTransportConfig {
  readonly accessToken: string;
  readonly graphApiVersion: string;
  readonly timeoutMs: number;
}

export interface MetaWhatsAppTransportDependencies {
  readonly fetch?: typeof fetch;
}

function nonEmpty(name: string, value: string | undefined, maximum = 4096): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${name}_INVALID`);
  }
  return normalized;
}

async function readSecret(env: NodeJS.ProcessEnv, directName: string, fileName: string): Promise<string> {
  const direct = env[directName];
  const file = env[fileName]?.trim();
  if (direct !== undefined && file) throw new Error(`${directName}_SOURCE_CONFLICT`);
  let value = direct;
  if (file) {
    try { value = await readFile(file, "utf8"); }
    catch { throw new Error(`${directName}_FILE_UNREADABLE`); }
  }
  return nonEmpty(directName, value);
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name}_INVALID`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name}_INVALID`);
  return value;
}

export async function loadMetaWhatsAppTransportConfig(env: NodeJS.ProcessEnv = process.env): Promise<MetaWhatsAppTransportConfig> {
  const graphApiVersion = nonEmpty("META_GRAPH_API_VERSION", env.META_GRAPH_API_VERSION, 32);
  if (!API_VERSION.test(graphApiVersion)) throw new Error("META_GRAPH_API_VERSION_INVALID");
  return {
    accessToken: await readSecret(env, "META_WHATSAPP_ACCESS_TOKEN", "META_WHATSAPP_ACCESS_TOKEN_FILE"),
    graphApiVersion,
    timeoutMs: integer(env, "META_WHATSAPP_TIMEOUT_MS", 10_000, 500, 60_000),
  };
}

function abortableSignal(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  parent.addEventListener("abort", abort, { once: true });
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent.removeEventListener("abort", abort); } };
}

export function createMetaWhatsAppTransport(
  config: MetaWhatsAppTransportConfig,
  dependencies: MetaWhatsAppTransportDependencies = {},
): OutboundTransport {
  const request = dependencies.fetch ?? fetch;
  return {
    async sendText(input: OutboundTransportInput, parentSignal: AbortSignal): Promise<OutboundTransportResult> {
      if (!PHONE_NUMBER_ID.test(input.channelAccountId)) throw new Error("META_WHATSAPP_PHONE_NUMBER_ID_INVALID");
      if (!RECIPIENT.test(input.recipientExternalId)) throw new Error("META_WHATSAPP_RECIPIENT_INVALID");
      if (!input.body || input.body.length > 4096 || /[\u0000-\u001f\u007f]/.test(input.body)) {
        throw new Error("META_WHATSAPP_BODY_INVALID");
      }
      if (parentSignal.aborted) throw new Error("META_WHATSAPP_ABORTED");
      const controlled = abortableSignal(parentSignal, config.timeoutMs);
      try {
        const response = await request(`${GRAPH_ORIGIN}/${config.graphApiVersion}/${encodeURIComponent(input.channelAccountId)}/messages`, {
          method: "POST",
          signal: controlled.signal,
          headers: { authorization: `Bearer ${config.accessToken}`, "content-type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", to: input.recipientExternalId, type: "text", text: { body: input.body, preview_url: false } }),
        });
        if (!response.ok) throw new Error(`META_WHATSAPP_HTTP_${response.status}`);
        let payload: unknown;
        try { payload = await response.json(); } catch { throw new Error("META_WHATSAPP_RESPONSE_INVALID"); }
        const id = payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).messages)
          ? ((payload as Record<string, unknown>).messages as unknown[])[0]
          : undefined;
        const externalMessageId = id && typeof id === "object" ? (id as Record<string, unknown>).id : undefined;
        if (typeof externalMessageId !== "string" || externalMessageId.trim() !== externalMessageId || !externalMessageId) {
          throw new Error("META_WHATSAPP_RESPONSE_INVALID");
        }
        return { externalMessageId };
      } catch (error) {
        if (parentSignal.aborted || controlled.signal.aborted) throw new Error("META_WHATSAPP_ABORTED");
        if (error instanceof Error && /^META_WHATSAPP_/.test(error.message)) throw error;
        throw new Error("META_WHATSAPP_REQUEST_FAILED");
      } finally { controlled.dispose(); }
    },
  };
}
