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

export const InvitationRoleSchema = Type.Union([
  Type.Literal("UNIT_MANAGER"), Type.Literal("SUPERVISOR"), Type.Literal("ATTENDANT"), Type.Literal("AUDITOR"),
]);
export type InvitationRole = Static<typeof InvitationRoleSchema>;

export const CreateUserInvitationRequestSchema = Type.Object({
  email: Type.String({ minLength: 3, maxLength: 320 }),
  displayName: Type.String({ minLength: 1, maxLength: 160 }),
  providerCode: Type.String({ pattern: "^[a-z][a-z0-9_-]{1,62}$" }),
  expiresAt: Type.String({ format: "date-time" }),
  assignments: Type.Array(Type.Object({
    unitId: Type.String({ format: "uuid" }),
    role: InvitationRoleSchema,
  }, { additionalProperties: false }), { minItems: 1, maxItems: 50 }),
}, { $id: "CreateUserInvitationRequest", additionalProperties: false });
export type CreateUserInvitationRequest = Static<typeof CreateUserInvitationRequestSchema>;

const UserInvitationSchema = Type.Object({
  invitation: Type.Object({
    id: Type.String({ format: "uuid" }),
    email: Type.String(),
    displayName: Type.String(),
    status: Type.Union([Type.Literal("PENDING"), Type.Literal("ACCEPTED"), Type.Literal("REVOKED"), Type.Literal("EXPIRED")]),
    expiresAt: Type.String({ format: "date-time" }),
    providerCode: Type.String(),
  }, { additionalProperties: false }),
  assignments: Type.Array(Type.Object({
    unitId: Type.String({ format: "uuid" }),
    unitCode: Type.String(),
    unitName: Type.String(),
    role: InvitationRoleSchema,
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export const CreateUserInvitationResponseSchema = Type.Union([
  Type.Composite([UserInvitationSchema, Type.Object({
    replayed: Type.Literal(false),
    invitationToken: Type.String({ minLength: 43, maxLength: 43, pattern: "^[A-Za-z0-9_-]+$" }),
  }, { additionalProperties: false })], { additionalProperties: false }),
  Type.Composite([UserInvitationSchema, Type.Object({ replayed: Type.Literal(true) },
    { additionalProperties: false })], { additionalProperties: false }),
], { $id: "CreateUserInvitationResponse" });
export type CreateUserInvitationResponse = Static<typeof CreateUserInvitationResponseSchema>;

export const UserInvitationOptionsSchema = Type.Object({
  providers: Type.Array(Type.Object({ code: Type.String() }, { additionalProperties: false })),
  units: Type.Array(Type.Object({
    id: Type.String({ format: "uuid" }), code: Type.String(), name: Type.String(),
  }, { additionalProperties: false })),
  roles: Type.Array(InvitationRoleSchema),
}, { $id: "UserInvitationOptions", additionalProperties: false });
export type UserInvitationOptions = Static<typeof UserInvitationOptionsSchema>;
