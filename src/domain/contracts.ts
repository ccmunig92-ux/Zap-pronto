export type TenantId = string & { readonly __brand: "TenantId" };
export type UnitId = string & { readonly __brand: "UnitId" };
export type ConversationId = string & { readonly __brand: "ConversationId" };
export type ServiceCaseId = string & { readonly __brand: "ServiceCaseId" };
export type UserId = string & { readonly __brand: "UserId" };

export type ChannelType = "WHATSAPP" | "INSTAGRAM" | "FACEBOOK_MESSENGER";
export type ChannelScope = "CORPORATE" | "SINGLE_UNIT" | "SELECTED_UNITS";

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
