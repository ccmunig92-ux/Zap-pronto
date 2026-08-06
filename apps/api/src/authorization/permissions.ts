export const permissions = [
  "tenant.users.manage", "unit.members.manage", "handoff.read", "handoff.claim",
  "quote.read", "quote.review", "quote.publish", "medical_order.read", "medical_order.review",
] as const;
export type Permission = typeof permissions[number];

export const rolePermissions = {
  TENANT_ADMIN: permissions,
  UNIT_MANAGER: permissions.filter((permission) => permission !== "tenant.users.manage"),
  SUPERVISOR: ["handoff.read", "handoff.claim", "quote.read", "quote.review", "medical_order.read", "medical_order.review"],
  ATTENDANT: ["handoff.read", "handoff.claim", "quote.read", "medical_order.read"],
  AUDITOR: ["handoff.read", "quote.read", "medical_order.read"],
} as const satisfies Record<string, readonly Permission[]>;
