import type {
  AppointmentMode,
  AutomationStatus,
  Conversation,
  HandoffReason,
  PriceEvidence,
} from "./contracts.js";

const HANDOFF_REASONS: ReadonlySet<HandoffReason> = new Set([
  "COMPLETED_COLLECTION",
  "CUSTOMER_REQUEST",
  "MISSING_INFORMATION",
  "DOCUMENT_UNREADABLE",
  "AUDIO_UNINTELLIGIBLE",
  "PROCEDURE_AMBIGUOUS",
  "PRICE_UNAVAILABLE",
  "QUOTE_REVIEW_REQUIRED",
  "APPOINTMENT_REQUEST",
  "INTEGRATION_FAILURE",
  "TOOL_FAILURE",
  "CLINICAL_QUESTION",
  "POSSIBLE_EMERGENCY",
  "COMPLAINT",
  "CANCELLATION",
  "RESCHEDULING",
  "NO_PROGRESS",
  "POLICY_BLOCK",
  "UNEXPECTED_ERROR",
]);

export function canAutomationReply(status: AutomationStatus): boolean {
  return status === "ACTIVE";
}

export function canAgentConfirmAppointment(mode: AppointmentMode): boolean {
  return mode === "AUTOMATED_WRITE";
}

export function requiresHumanHandoff(reason: HandoffReason): boolean {
  return HANDOFF_REASONS.has(reason);
}

export function assertQuoteEvidence(evidence: PriceEvidence): void {
  if (!evidence.unitId) throw new Error("QUOTE_UNIT_REQUIRED");
  if (!evidence.priceListVersionId) throw new Error("PRICE_VERSION_REQUIRED");
  if (evidence.amountMinor <= 0n) throw new Error("POSITIVE_PRICE_REQUIRED");
}

export function assertReplyAllowed(
  conversation: Conversation,
  actor: "HERMES" | "HUMAN",
): void {
  if (actor === "HERMES" && !canAutomationReply(conversation.automationStatus)) {
    throw new Error("AUTOMATION_SUSPENDED");
  }
  if (actor === "HUMAN" && conversation.assignedUserId === null) {
    throw new Error("HUMAN_ASSIGNMENT_REQUIRED");
  }
}

