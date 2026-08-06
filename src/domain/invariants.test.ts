import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  Conversation,
  ConversationId,
  PriceEvidence,
  TenantId,
  UnitId,
  UserId,
} from "./contracts.js";
import {
  assertQuoteEvidence,
  assertReplyAllowed,
  canAgentConfirmAppointment,
  canAutomationReply,
  requiresHumanHandoff,
} from "./invariants.js";

const tenantId = "tenant-1" as TenantId;
const unitId = "unit-1" as UnitId;

describe("invariantes da plataforma", () => {
  it("suspende o Hermes durante atendimento humano", () => {
    assert.equal(canAutomationReply("ACTIVE"), true);
    assert.equal(canAutomationReply("HUMAN_QUEUED"), false);
    assert.equal(canAutomationReply("HUMAN_ACTIVE"), false);
  });

  it("impede confirmação automática no modo manual", () => {
    assert.equal(canAgentConfirmAppointment("MANUAL"), false);
    assert.equal(canAgentConfirmAppointment("READ_ONLY_AVAILABILITY"), false);
    assert.equal(canAgentConfirmAppointment("HUMAN_CONFIRMED_WRITE"), false);
    assert.equal(canAgentConfirmAppointment("AUTOMATED_WRITE"), true);
  });

  it("exige handoff após coleta, problema ou pedido humano", () => {
    assert.equal(requiresHumanHandoff("COMPLETED_COLLECTION"), true);
    assert.equal(requiresHumanHandoff("TOOL_FAILURE"), true);
    assert.equal(requiresHumanHandoff("CUSTOMER_REQUEST"), true);
  });

  it("exige evidência válida para preço", () => {
    const price: PriceEvidence = {
      tenantId,
      unitId,
      catalogItemId: "exam-1",
      priceListVersionId: "prices-v1",
      amountMinor: 15000n,
      currency: "BRL",
      source: "PLATFORM",
      effectiveAt: "2026-08-05T00:00:00-03:00",
    };
    assert.doesNotThrow(() => assertQuoteEvidence(price));
    assert.throws(() => assertQuoteEvidence({ ...price, amountMinor: 0n }), /POSITIVE_PRICE_REQUIRED/);
  });

  it("impede Hermes suspenso e humano sem atribuição", () => {
    const conversation: Conversation = {
      id: "conversation-1" as ConversationId,
      tenantId,
      channelConnectionId: "channel-1",
      unitId,
      automationStatus: "HUMAN_ACTIVE",
      assignedUserId: "user-1" as UserId,
      version: 1,
    };
    assert.throws(() => assertReplyAllowed(conversation, "HERMES"), /AUTOMATION_SUSPENDED/);
    assert.doesNotThrow(() => assertReplyAllowed(conversation, "HUMAN"));
    assert.throws(
      () => assertReplyAllowed({ ...conversation, assignedUserId: null }, "HUMAN"),
      /HUMAN_ASSIGNMENT_REQUIRED/,
    );
  });
});

