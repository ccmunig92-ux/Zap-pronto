export type TenantId = string & { readonly __brand: "TenantId" };
export type UnitId = string & { readonly __brand: "UnitId" };
export type ConversationId = string & { readonly __brand: "ConversationId" };
export type ServiceCaseId = string & { readonly __brand: "ServiceCaseId" };
export type UserId = string & { readonly __brand: "UserId" };

export type ChannelType = "WHATSAPP" | "INSTAGRAM" | "FACEBOOK_MESSENGER";
export type ChannelScope = "CORPORATE" | "SINGLE_UNIT" | "SELECTED_UNITS";

export type InboundChannel = "WHATSAPP" | "INSTAGRAM" | "FACEBOOK";
export type InboundProvider = "META_WHATSAPP" | "META_INSTAGRAM" | "META_FACEBOOK";
export type InboundContentKind = "TEXT" | "AUDIO" | "IMAGE" | "DOCUMENT" | "INTERACTIVE";

interface InboundEnvelopeBase {
  readonly provider: InboundProvider;
  readonly channel: InboundChannel;
  readonly providerEventId: string;
  readonly channelAccountId: string;
  readonly senderExternalId: string;
  readonly recipientExternalId: string;
  readonly occurredAt: string;
}

export type InboundEnvelope = InboundEnvelopeBase & (
  | { readonly kind: "TEXT"; readonly payload: { readonly text: string } }
  | { readonly kind: "AUDIO"; readonly payload: { readonly mediaId: string; readonly mimeType?: string;
      readonly trust: "UNTRUSTED" } }
  | { readonly kind: "IMAGE"; readonly payload: { readonly mediaId: string; readonly mimeType?: string;
      readonly caption?: string; readonly trust: "UNTRUSTED" } }
  | { readonly kind: "DOCUMENT"; readonly payload: { readonly mediaId: string; readonly mimeType?: string;
      readonly fileName?: string; readonly caption?: string; readonly trust: "UNTRUSTED" } }
  | { readonly kind: "INTERACTIVE"; readonly payload: { readonly interactionId: string;
      readonly title?: string; readonly trust: "UNTRUSTED" } }
);

export interface ChannelInboundAdapter<RawPayload = unknown> {
  readonly provider: InboundProvider;
  readonly channel: InboundChannel;
  normalize(payload: RawPayload): readonly InboundEnvelope[];
}

export type AutomationStatus =
  | "ACTIVE"
  | "HUMAN_REQUESTED"
  | "HUMAN_QUEUED"
  | "HUMAN_ACTIVE"
  | "SUSPENDED";

export type HandoffReason =
  | "COMPLETED_COLLECTION"
  | "CUSTOMER_REQUEST"
  | "MISSING_INFORMATION"
  | "DOCUMENT_UNREADABLE"
  | "AUDIO_UNINTELLIGIBLE"
  | "PROCEDURE_AMBIGUOUS"
  | "PRICE_UNAVAILABLE"
  | "QUOTE_REVIEW_REQUIRED"
  | "APPOINTMENT_REQUEST"
  | "INTEGRATION_FAILURE"
  | "TOOL_FAILURE"
  | "CLINICAL_QUESTION"
  | "POSSIBLE_EMERGENCY"
  | "COMPLAINT"
  | "CANCELLATION"
  | "RESCHEDULING"
  | "NO_PROGRESS"
  | "POLICY_BLOCK"
  | "UNEXPECTED_ERROR";

export type AppointmentMode =
  | "MANUAL"
  | "READ_ONLY_AVAILABILITY"
  | "HUMAN_CONFIRMED_WRITE"
  | "AUTOMATED_WRITE";

export interface TenantScoped {
  tenantId: TenantId;
}

export interface ChannelConnection extends TenantScoped {
  id: string;
  type: ChannelType;
  scope: ChannelScope;
  allowedUnitIds: readonly UnitId[];
  status: "ACTIVE" | "DEGRADED" | "DISCONNECTED";
}

export interface Conversation extends TenantScoped {
  id: ConversationId;
  channelConnectionId: string;
  unitId: UnitId | null;
  automationStatus: AutomationStatus;
  assignedUserId: UserId | null;
  version: number;
}

export interface HumanHandoff extends TenantScoped {
  id: string;
  conversationId: ConversationId;
  serviceCaseId: ServiceCaseId;
  unitId: UnitId | null;
  reason: HandoffReason;
  priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  status: "REQUESTED" | "QUEUED" | "ACTIVE" | "RESOLVED" | "FAILED" | "CANCELLED";
  idempotencyKey: string;
}

export interface PriceEvidence extends TenantScoped {
  unitId: UnitId;
  catalogItemId: string;
  priceListVersionId: string;
  amountMinor: bigint;
  currency: "BRL";
  source: "PLATFORM" | "EXTERNAL_SNAPSHOT" | "EXTERNAL_REALTIME";
  effectiveAt: string;
}
