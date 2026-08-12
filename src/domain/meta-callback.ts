import type { InboundEnvelope } from "./contracts.js";
import { normalizeWhatsAppInbound } from "./channel-inbound.js";

type UnknownRecord = Record<string, unknown>;
const SUPPORTED_WHATSAPP_TYPES = new Set(["text", "audio", "image", "document", "interactive"]);
export const META_CALLBACK_LIMITS = Object.freeze({ entries: 100, changesPerEntry: 100, messagesPerChange: 100,
  messagesTotal: 1_000, statusesTotal: 10_000 });

function object(value: unknown): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("INVALID_META_CALLBACK");
  return value as UnknownRecord;
}

export interface ClassifiedMetaCallback {
  readonly messages: readonly InboundEnvelope[];
  readonly statuses: readonly MetaDeliveryStatusEvent[];
  readonly statusCount: number;
  readonly ignoredCount: number;
}
export interface MetaDeliveryStatusEvent{readonly provider:"META_WHATSAPP";readonly channelAccountId:string;
  readonly externalMessageId:string;readonly recipientExternalId:string|null;readonly providerStatus:string;
  readonly normalizedStatus:"SENT"|"DELIVERED"|"READ"|"FAILED"|null;readonly occurredAt:string;readonly errorCodes:readonly number[]}
const STATUS_MAP:Readonly<Record<string,"SENT"|"DELIVERED"|"READ"|"FAILED">>=Object.freeze({sent:"SENT",delivered:"DELIVERED",read:"READ",failed:"FAILED"});
function boundedString(value:unknown,max=512):string{if(typeof value!=="string"||value.length<1||value.length>max||value!==value.trim()||/[\u0000-\u001f\u007f]/.test(value))throw new Error("INVALID_META_CALLBACK");return value;}
function normalizeStatus(raw:unknown,accountId:string):MetaDeliveryStatusEvent{const status=object(raw);const externalMessageId=boundedString(status.id);
  const rawStatus=boundedString(status.status,64);if(!/^[a-z_]+$/.test(rawStatus))throw new Error("INVALID_META_CALLBACK");
  if(typeof status.timestamp!=="string"||!/^[0-9]{1,12}$/.test(status.timestamp))throw new Error("INVALID_META_CALLBACK");const seconds=Number(status.timestamp);
  if(!Number.isSafeInteger(seconds)||seconds<0){throw new Error("INVALID_META_CALLBACK")}const occurred=new Date(seconds*1000);if(!Number.isFinite(occurred.getTime()))throw new Error("INVALID_META_CALLBACK");
  const recipient=status.recipient_id===undefined?null:boundedString(status.recipient_id);const errorCodes:number[]=[];
  if(status.errors!==undefined){if(!Array.isArray(status.errors)||status.errors.length>20)throw new Error("INVALID_META_CALLBACK");for(const rawError of status.errors){const error=object(rawError);
      if(!Number.isInteger(error.code)||Number(error.code)<0||Number(error.code)>2147483647)throw new Error("INVALID_META_CALLBACK");errorCodes.push(Number(error.code));}}
  return{provider:"META_WHATSAPP",channelAccountId:accountId,externalMessageId,recipientExternalId:recipient,
    providerStatus:Object.hasOwn(STATUS_MAP,rawStatus)?rawStatus:"unknown",normalizedStatus:STATUS_MAP[rawStatus]??null,
    occurredAt:occurred.toISOString(),errorCodes};}

/** Classifies an authenticated callback without making unsupported event types retry forever. */
export function classifyMetaCallback(payload: unknown): ClassifiedMetaCallback {
  const root = object(payload);
  if (!Array.isArray(root.entry) || root.entry.length < 1 || root.entry.length > META_CALLBACK_LIMITS.entries) {
    throw new Error("INVALID_META_CALLBACK");
  }
  const messages: InboundEnvelope[] = [];
  const statuses: MetaDeliveryStatusEvent[]=[];
  let statusCount = 0;
  let ignoredCount = 0;
  let rawMessageCount = 0;
  for (const rawEntry of root.entry) {
    const entry = object(rawEntry);
    if (!Array.isArray(entry.changes) || entry.changes.length > META_CALLBACK_LIMITS.changesPerEntry) {
      throw new Error("INVALID_META_CALLBACK");
    }
    for (const rawChange of entry.changes) {
      const change = object(rawChange);
      const value = object(change.value);
      if (value.statuses !== undefined) {
        if (!Array.isArray(value.statuses)) throw new Error("INVALID_META_CALLBACK");
        statusCount += value.statuses.length;
        if (statusCount > META_CALLBACK_LIMITS.statusesTotal) throw new Error("META_CALLBACK_LIMIT_EXCEEDED");
        const metadata=object(value.metadata);const accountId=boundedString(metadata.phone_number_id);
        for(const rawStatus of value.statuses)statuses.push(normalizeStatus(rawStatus,accountId));
      }
      if (value.messages === undefined) {
        if (value.statuses === undefined) ignoredCount += 1;
        continue;
      }
      if (!Array.isArray(value.messages) || value.messages.length > META_CALLBACK_LIMITS.messagesPerChange) {
        throw new Error("INVALID_META_CALLBACK");
      }
      rawMessageCount += value.messages.length;
      if (rawMessageCount > META_CALLBACK_LIMITS.messagesTotal) {
        throw new Error("META_CALLBACK_LIMIT_EXCEEDED");
      }
      const supported: unknown[] = [];
      for (const rawMessage of value.messages) {
        const message = object(rawMessage);
        if (typeof message.type === "string" && SUPPORTED_WHATSAPP_TYPES.has(message.type)) supported.push(message);
        else ignoredCount += 1;
      }
      if (supported.length === 0) continue;
      messages.push(...normalizeWhatsAppInbound({ entry: [{ changes: [{ value: {
        metadata: value.metadata,
        messages: supported,
      } }] }] }));
    }
  }
  return { messages,statuses, statusCount, ignoredCount };
}
