import { permissionValues, type Permission } from "@zap-pronto/contracts";
export const permissions = permissionValues;
export type { Permission };

export const rolePermissions = {
  TENANT_ADMIN: permissions,
  UNIT_MANAGER: ["availability.supervise", "sla_policy.read", "sla_policy.manage", "sla_alert.read", "sla_alert.acknowledge", "unit.members.manage", "handoff.read", "handoff.history.read", "handoff.claim", "handoff.resolve", "handoff.reopen", "handoff.requeue", "handoff.transfer", "handoff.takeover", "conversation.read", "conversation.supervise", "message.send", "message.cancel", "quote.read", "quote.review", "quote.publish", "medical_order.read", "medical_order.review"],
  SUPERVISOR: ["availability.supervise", "sla_policy.read", "sla_alert.read", "sla_alert.acknowledge", "handoff.read", "handoff.history.read", "handoff.claim", "handoff.resolve", "handoff.reopen", "handoff.requeue", "handoff.transfer", "handoff.takeover", "conversation.read", "conversation.supervise", "message.send", "message.cancel", "quote.read", "quote.review", "medical_order.read", "medical_order.review"],
  ATTENDANT: ["handoff.read", "handoff.claim", "handoff.resolve", "handoff.requeue", "handoff.transfer", "conversation.read", "message.send", "message.cancel", "quote.read", "medical_order.read"],
  AUDITOR: ["handoff.read", "quote.read", "medical_order.read"],
} as const satisfies Record<string, readonly Permission[]>;
