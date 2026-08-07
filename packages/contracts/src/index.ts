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

export const UserMembershipSchema = Type.Object({
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
  memberships: Type.Array(UserMembershipSchema),
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

export const UserLifecycleActionSchema = Type.Union([
  Type.Literal("BLOCK"), Type.Literal("ACTIVATE"), Type.Literal("REVOKE"),
]);
export const InvitationLifecycleActionSchema = Type.Union([
  Type.Literal("REVOKE"), Type.Literal("REISSUE"),
]);

export const AdministrativeUserSchema = Type.Object({
  id: Type.String({ format: "uuid" }), email: Type.String(), displayName: Type.String(),
  status: Type.Union([Type.Literal("ACTIVE"), Type.Literal("BLOCKED"), Type.Literal("REVOKED")]),
  version: Type.Integer({ minimum: 1 }), memberships: Type.Array(UserMembershipSchema),
  allowedActions: Type.Array(UserLifecycleActionSchema, { uniqueItems: true }),
}, { additionalProperties: false });
export type AdministrativeUser = Static<typeof AdministrativeUserSchema>;

export const AdministrativeInvitationSchema = Type.Object({
  id: Type.String({ format: "uuid" }), email: Type.String(), displayName: Type.String(),
  status: Type.Union([Type.Literal("PENDING"), Type.Literal("ACCEPTED"), Type.Literal("REVOKED"), Type.Literal("EXPIRED")]),
  expiresAt: Type.String({ format: "date-time" }), providerCode: Type.String(),
  assignments: Type.Array(Type.Object({ unitId: Type.String({ format: "uuid" }), unitCode: Type.String(),
    unitName: Type.String(), role: InvitationRoleSchema }, { additionalProperties: false })),
  allowedActions: Type.Array(InvitationLifecycleActionSchema, { uniqueItems: true }),
}, { additionalProperties: false });
export type AdministrativeInvitation = Static<typeof AdministrativeInvitationSchema>;

export const AdministrativeUsersPageSchema = Type.Object({
  items: Type.Array(AdministrativeUserSchema), nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
}, { $id: "AdministrativeUsersPage", additionalProperties: false });
export type AdministrativeUsersPage = Static<typeof AdministrativeUsersPageSchema>;

export const AdministrativeInvitationsPageSchema = Type.Object({
  items: Type.Array(AdministrativeInvitationSchema), nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
}, { $id: "AdministrativeInvitationsPage", additionalProperties: false });
export type AdministrativeInvitationsPage = Static<typeof AdministrativeInvitationsPageSchema>;

export const ChangeUserStatusRequestSchema = Type.Object({
  action: UserLifecycleActionSchema, expectedVersion: Type.Integer({ minimum: 1 }),
  reason: Type.String({ minLength: 3, maxLength: 500 }),
}, { $id: "ChangeUserStatusRequest", additionalProperties: false });
export type ChangeUserStatusRequest = Static<typeof ChangeUserStatusRequestSchema>;

export const RevokeInvitationRequestSchema = Type.Object({ reason: Type.String({ minLength: 3, maxLength: 500 }) },
  { $id: "RevokeInvitationRequest", additionalProperties: false });
export type RevokeInvitationRequest = Static<typeof RevokeInvitationRequestSchema>;

export const ReissueInvitationRequestSchema = Type.Object({
  expiresAt: Type.String({ format: "date-time" }), reason: Type.String({ minLength: 3, maxLength: 500 }),
}, { $id: "ReissueInvitationRequest", additionalProperties: false });
export type ReissueInvitationRequest = Static<typeof ReissueInvitationRequestSchema>;

export const ChangeUserStatusResponseSchema = Type.Object({
  user: Type.Object({ id: Type.String({ format: "uuid" }),
    status: Type.Union([Type.Literal("ACTIVE"), Type.Literal("BLOCKED"), Type.Literal("REVOKED")]),
    version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
  replayed: Type.Boolean(),
}, { $id: "ChangeUserStatusResponse", additionalProperties: false });
export type ChangeUserStatusResponse = Static<typeof ChangeUserStatusResponseSchema>;

const InvitationMutationBaseSchema = Type.Object({ invitation: AdministrativeInvitationSchema },
  { additionalProperties: false });
export const RevokeInvitationResponseSchema = Type.Composite([InvitationMutationBaseSchema,
  Type.Object({ replayed: Type.Boolean() }, { additionalProperties: false })],
{ $id: "RevokeInvitationResponse", additionalProperties: false });
export type RevokeInvitationResponse = Static<typeof RevokeInvitationResponseSchema>;

export const ReissueInvitationResponseSchema = Type.Union([
  Type.Composite([InvitationMutationBaseSchema, Type.Object({ replayed: Type.Literal(false),
    invitationToken: Type.String({ minLength: 43, maxLength: 43, pattern: "^[A-Za-z0-9_-]+$" }) },
  { additionalProperties: false })], { additionalProperties: false }),
  Type.Composite([InvitationMutationBaseSchema, Type.Object({ replayed: Type.Literal(true) },
    { additionalProperties: false })], { additionalProperties: false }),
], { $id: "ReissueInvitationResponse" });
export type ReissueInvitationResponse = Static<typeof ReissueInvitationResponseSchema>;

export const AcceptUserInvitationRequestSchema = Type.Object({
  invitationToken: Type.String({ minLength: 43, maxLength: 43, pattern: "^[A-Za-z0-9_-]+$" }),
}, { $id: "AcceptUserInvitationRequest", additionalProperties: false });
export type AcceptUserInvitationRequest = Static<typeof AcceptUserInvitationRequestSchema>;

export const AcceptUserInvitationResponseSchema = Type.Object({
  currentUser: CurrentUserSchema,
  replayed: Type.Boolean(),
}, { $id: "AcceptUserInvitationResponse", additionalProperties: false });
export type AcceptUserInvitationResponse = Static<typeof AcceptUserInvitationResponseSchema>;
