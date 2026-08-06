import { Type, type Static } from "@sinclair/typebox";

export const ProblemDetailsSchema = Type.Object({
  type: Type.String(),
  title: Type.String(),
  status: Type.Integer({ minimum: 400, maximum: 599 }),
  detail: Type.Optional(Type.String()),
  correlationId: Type.String(),
}, { $id: "ProblemDetails" });
export type ProblemDetails = Static<typeof ProblemDetailsSchema>;

export const HealthSchema = Type.Object({ status: Type.Literal("ok") }, { $id: "Health" });
export type Health = Static<typeof HealthSchema>;

export const PrincipalSchema = Type.Object({
  userId: Type.String({ format: "uuid" }),
  tenantId: Type.String({ format: "uuid" }),
  unitIds: Type.Array(Type.String({ format: "uuid" })),
});
export type Principal = Static<typeof PrincipalSchema>;

export const AppRoleSchema = Type.Union([
  Type.Literal("TENANT_ADMIN"), Type.Literal("UNIT_MANAGER"), Type.Literal("SUPERVISOR"),
  Type.Literal("ATTENDANT"), Type.Literal("AUDITOR"),
], { $id: "AppRole" });
export type AppRole = Static<typeof AppRoleSchema>;

export const permissionValues = [
  "tenant.users.manage", "unit.members.manage", "handoff.read", "handoff.claim",
  "quote.read", "quote.review", "quote.publish", "medical_order.read", "medical_order.review",
] as const;
export const PermissionSchema = Type.Union(permissionValues.map((permission) => Type.Literal(permission)));
export type Permission = Static<typeof PermissionSchema>;

const MembershipSchema = Type.Object({
  unitId: Type.String({ format: "uuid" }),
  unitCode: Type.String(),
  unitName: Type.String(),
  role: AppRoleSchema,
}, { additionalProperties: false });

const GrantSchema = Type.Union([
  Type.Object({ permission: PermissionSchema, scope: Type.Literal("TENANT") }, { additionalProperties: false }),
  Type.Object({ permission: PermissionSchema, scope: Type.Literal("UNIT"),
    unitId: Type.String({ format: "uuid" }) }, { additionalProperties: false }),
]);

export const CurrentUserSchema = Type.Object({
  user: Type.Object({
    id: Type.String({ format: "uuid" }),
    email: Type.String(),
    displayName: Type.String(),
  }, { additionalProperties: false }),
  tenant: Type.Object({
    id: Type.String({ format: "uuid" }),
    name: Type.String(),
  }, { additionalProperties: false }),
  memberships: Type.Array(MembershipSchema),
  grants: Type.Array(GrantSchema),
}, { $id: "CurrentUser", additionalProperties: false });
export type CurrentUser = Static<typeof CurrentUserSchema>;
