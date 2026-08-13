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
  "tenant.users.manage", "unit.members.manage", "handoff.read", "handoff.history.read", "handoff.claim", "handoff.resolve", "handoff.reopen", "handoff.requeue", "handoff.transfer", "handoff.takeover", "conversation.read", "conversation.supervise",
  "quote.read", "quote.review", "quote.publish", "medical_order.read", "medical_order.review",
  "inbound.routing.read", "inbound.routing.resolve",
  "message.send", "message.cancel", "sla_alert.read", "sla_alert.acknowledge", "sla_policy.read", "sla_policy.manage", "availability.supervise", "unit_timezone.read", "unit_timezone.manage", "shift.read", "shift.manage",
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
export const UnitMembershipLifecycleActionSchema = Type.Union([Type.Literal("REVOKE"),Type.Literal("REACTIVATE")]);
export const AdministrativeUnitMembershipSchema=Type.Object({unitId:Type.String({format:"uuid"}),unitCode:Type.String(),unitName:Type.String(),role:Type.Union([Type.Literal("TENANT_ADMIN"),InvitationRoleSchema]),
  status:Type.Union([Type.Literal("ACTIVE"),Type.Literal("REVOKED")]),version:Type.Integer({minimum:1}),
  allowedActions:Type.Array(UnitMembershipLifecycleActionSchema,{uniqueItems:true})},{additionalProperties:false});

export const AdministrativeUserSchema = Type.Object({
  id: Type.String({ format: "uuid" }), email: Type.String(), displayName: Type.String(),
  status: Type.Union([Type.Literal("ACTIVE"), Type.Literal("BLOCKED"), Type.Literal("REVOKED")]),
  version: Type.Integer({ minimum: 1 }), memberships: Type.Array(AdministrativeUnitMembershipSchema),
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

export const ChangeUnitMembershipParamsSchema=Type.Object({userId:Type.String({format:"uuid"}),unitId:Type.String({format:"uuid"})},{additionalProperties:false});
export type ChangeUnitMembershipParams=Static<typeof ChangeUnitMembershipParamsSchema>;
export const ChangeUnitMembershipRequestSchema=Type.Object({expectedVersion:Type.Integer({minimum:1}),
  operation:Type.Union([Type.Literal("REVOKE"),Type.Literal("REACTIVATE")]),reason:Type.String({minLength:3,maxLength:500})},{additionalProperties:false});
export type ChangeUnitMembershipRequest=Static<typeof ChangeUnitMembershipRequestSchema>;
export const ChangeUnitMembershipResponseSchema=Type.Object({membership:Type.Object({userId:Type.String({format:"uuid"}),unitId:Type.String({format:"uuid"}),
  status:Type.Union([Type.Literal("ACTIVE"),Type.Literal("REVOKED")]),version:Type.Integer({minimum:1})},{additionalProperties:false}),replayed:Type.Boolean()},{additionalProperties:false});
export type ChangeUnitMembershipResponse=Static<typeof ChangeUnitMembershipResponseSchema>;

export const ListUnitMembershipsParamsSchema=Type.Object({
  unitId:Type.String({format:"uuid"}),
},{$id:"ListUnitMembershipsParams",additionalProperties:false});
export type ListUnitMembershipsParams=Static<typeof ListUnitMembershipsParamsSchema>;
export const ListUnitMembershipsQuerySchema=Type.Object({
  limit:Type.Optional(Type.Integer({minimum:1,maximum:100,default:25})),
  cursor:Type.Optional(Type.String({minLength:1,maxLength:1024})),
},{$id:"ListUnitMembershipsQuery",additionalProperties:false});
export type ListUnitMembershipsQuery=Static<typeof ListUnitMembershipsQuerySchema>;
export const UnitMembershipMemberSchema=Type.Object({
  userId:Type.String({format:"uuid"}),displayName:Type.String(),
  role:Type.Union([Type.Literal("TENANT_ADMIN"),InvitationRoleSchema]),
  status:Type.Union([Type.Literal("ACTIVE"),Type.Literal("REVOKED")]),
  version:Type.Integer({minimum:1}),
  allowedActions:Type.Array(UnitMembershipLifecycleActionSchema,{uniqueItems:true}),
},{$id:"UnitMembershipMember",additionalProperties:false});
export type UnitMembershipMember=Static<typeof UnitMembershipMemberSchema>;
export const UnitMembershipsPageSchema=Type.Object({
  items:Type.Array(UnitMembershipMemberSchema),
  nextCursor:Type.Optional(Type.String({minLength:1,maxLength:1024})),
},{$id:"UnitMembershipsPage",additionalProperties:false});
export type UnitMembershipsPage=Static<typeof UnitMembershipsPageSchema>;

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

export const HandoffStatusSchema = Type.Union([
  Type.Literal("REQUESTED"), Type.Literal("QUEUED"), Type.Literal("ACTIVE"),
  Type.Literal("RESOLVED"), Type.Literal("FAILED"), Type.Literal("CANCELLED"),
], { $id: "HandoffStatus" });
export type HandoffStatus = Static<typeof HandoffStatusSchema>;

export const HandoffPrioritySchema = Type.Union([
  Type.Literal("LOW"), Type.Literal("NORMAL"), Type.Literal("HIGH"), Type.Literal("URGENT"),
], { $id: "HandoffPriority" });
export type HandoffPriority = Static<typeof HandoffPrioritySchema>;

export const HandoffAutomationStatusSchema = Type.Union([
  Type.Literal("ACTIVE"), Type.Literal("HUMAN_REQUESTED"), Type.Literal("HUMAN_QUEUED"),
  Type.Literal("HUMAN_ACTIVE"), Type.Literal("CLOSED"),
], { $id: "HandoffAutomationStatus" });
export type HandoffAutomationStatus = Static<typeof HandoffAutomationStatusSchema>;
export const HandoffSlaStatusSchema=Type.Union([Type.Literal("ON_TRACK"),Type.Literal("DUE_SOON"),Type.Literal("OVERDUE")],{$id:"HandoffSlaStatus"});
export type HandoffSlaStatus=Static<typeof HandoffSlaStatusSchema>;

export const InboxHandoffSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  conversationId: Type.String({ format: "uuid" }),
  serviceCaseId: Type.String({ format: "uuid" }),
  unitId: Type.String({ format: "uuid" }),
  contactName: Type.Union([Type.String({ maxLength: 160 }), Type.Null()]),
  reason: Type.String({ minLength: 1, maxLength: 200 }),
  priority: HandoffPrioritySchema,
  status: HandoffStatusSchema,
  assignedUserId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  requestedAt: Type.String({ format: "date-time" }),
  queuedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  slaDueAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  slaStatus:Type.Union([HandoffSlaStatusSchema,Type.Null()]),
  automationStatus: HandoffAutomationStatusSchema,
  version: Type.Integer({ minimum: 1 }),
}, { $id: "InboxHandoff", additionalProperties: false });
export type InboxHandoff = Static<typeof InboxHandoffSchema>;

export const ListHandoffsQuerySchema = Type.Object({
  unitId: Type.String({ format: "uuid" }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  priority:Type.Optional(HandoffPrioritySchema),
  slaStatus:Type.Optional(HandoffSlaStatusSchema),
}, { $id: "ListHandoffsQuery", additionalProperties: false });
export type ListHandoffsQuery = Static<typeof ListHandoffsQuerySchema>;
export const ListActiveHandoffsQuerySchema=Type.Object({unitId:Type.String({format:"uuid"}),limit:Type.Optional(Type.Integer({minimum:1,maximum:100,default:25})),
  cursor:Type.Optional(Type.String({minLength:1,maxLength:1024}))},{$id:"ListActiveHandoffsQuery",additionalProperties:false});
export type ListActiveHandoffsQuery=Static<typeof ListActiveHandoffsQuerySchema>;
export const ListSupervisedHandoffsQuerySchema=Type.Object({unitId:Type.String({format:"uuid"}),limit:Type.Optional(Type.Integer({minimum:1,maximum:100,default:25})),
  cursor:Type.Optional(Type.String({minLength:1,maxLength:1024}))},{$id:"ListSupervisedHandoffsQuery",additionalProperties:false});
export type ListSupervisedHandoffsQuery=Static<typeof ListSupervisedHandoffsQuerySchema>;

export const ResolvedHandoffDispositionSchema=Type.Union([
  Type.Literal("LEGACY_UNSPECIFIED"),Type.Literal("RESOLVED"),Type.Literal("DUPLICATE"),
  Type.Literal("CUSTOMER_WITHDREW"),Type.Literal("EXTERNAL_REFERRAL"),
],{$id:"ResolvedHandoffDisposition"});
export const ResolvedInboxHandoffSchema=Type.Object({
  id:Type.String({format:"uuid"}),conversationId:Type.String({format:"uuid"}),unitId:Type.String({format:"uuid"}),contactName:Type.Union([Type.String({maxLength:160}),Type.Null()]),
  reason:Type.String({minLength:1,maxLength:200}),priority:HandoffPrioritySchema,resolvedAt:Type.String({format:"date-time"}),
  disposition:ResolvedHandoffDispositionSchema,resolvedByUserId:Type.Union([Type.String({format:"uuid"}),Type.Null()]),
  resolvedByDisplayName:Type.Union([Type.String({maxLength:200}),Type.Null()]),version:Type.Integer({minimum:1}),
  reopenTarget:Type.Union([Type.Object({handoffId:Type.String({format:"uuid"}),expectedVersion:Type.Integer({minimum:1})},{additionalProperties:false}),Type.Null()]),
},{ $id:"ResolvedInboxHandoff",additionalProperties:false});
export type ResolvedInboxHandoff=Static<typeof ResolvedInboxHandoffSchema>;
export const ListResolvedHandoffsQuerySchema=Type.Object({unitId:Type.String({format:"uuid"}),
  limit:Type.Optional(Type.Integer({minimum:1,maximum:100,default:25})),cursor:Type.Optional(Type.String({minLength:1,maxLength:1024})),
  priority:Type.Optional(HandoffPrioritySchema),disposition:Type.Optional(ResolvedHandoffDispositionSchema),
  resolvedFrom:Type.Optional(Type.String({format:"date-time"})),resolvedBefore:Type.Optional(Type.String({format:"date-time"}))},
{$id:"ListResolvedHandoffsQuery",additionalProperties:false});
export type ListResolvedHandoffsQuery=Static<typeof ListResolvedHandoffsQuerySchema>;
export const ListResolvedHandoffsResponseSchema=Type.Object({items:Type.Array(ResolvedInboxHandoffSchema),
  nextCursor:Type.Optional(Type.String({minLength:1,maxLength:1024}))},{$id:"ListResolvedHandoffsResponse",additionalProperties:false});
export type ListResolvedHandoffsResponse=Static<typeof ListResolvedHandoffsResponseSchema>;

export const ListHandoffsResponseSchema = Type.Object({
  items: Type.Array(InboxHandoffSchema),
  nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
}, { $id: "ListHandoffsResponse", additionalProperties: false });
export type ListHandoffsResponse = Static<typeof ListHandoffsResponseSchema>;

export const ClaimHandoffParamsSchema = Type.Object({
  handoffId: Type.String({ format: "uuid" }),
}, { $id: "ClaimHandoffParams", additionalProperties: false });
export type ClaimHandoffParams = Static<typeof ClaimHandoffParamsSchema>;

export const ClaimHandoffRequestSchema = Type.Object({
  expectedVersion: Type.Integer({ minimum: 1 }),
}, { $id: "ClaimHandoffRequest", additionalProperties: false });
export type ClaimHandoffRequest = Static<typeof ClaimHandoffRequestSchema>;

export const ClaimHandoffResponseSchema = Type.Object({
  handoff: InboxHandoffSchema,
  replayed: Type.Boolean(),
}, { $id: "ClaimHandoffResponse", additionalProperties: false });
export type ClaimHandoffResponse = Static<typeof ClaimHandoffResponseSchema>;

export const RoutingRequiredActionSchema=Type.Literal("RESOLVE");
export const EligibleRoutingUnitSchema=Type.Object({id:Type.String({format:"uuid"}),code:Type.String(),name:Type.String()},
  {additionalProperties:false});
export const RoutingRequiredItemSchema=Type.Object({receiptId:Type.String({format:"uuid"}),
  channelConnectionId:Type.String({format:"uuid"}),provider:Type.String(),kind:Type.String(),
  occurredAt:Type.String({format:"date-time"}),receivedAt:Type.String({format:"date-time"}),
  eligibleUnits:Type.Array(EligibleRoutingUnitSchema),allowedActions:Type.Array(RoutingRequiredActionSchema,{uniqueItems:true})},
{additionalProperties:false});
export type RoutingRequiredItem=Static<typeof RoutingRequiredItemSchema>;
export const ListRoutingRequiredQuerySchema=Type.Object({limit:Type.Optional(Type.Integer({minimum:1,maximum:100,default:25})),
  cursor:Type.Optional(Type.String({minLength:1,maxLength:1024}))},{additionalProperties:false});
export type ListRoutingRequiredQuery=Static<typeof ListRoutingRequiredQuerySchema>;
export const ListRoutingRequiredResponseSchema=Type.Object({items:Type.Array(RoutingRequiredItemSchema),
  nextCursor:Type.Optional(Type.String({minLength:1,maxLength:1024}))},{$id:"ListRoutingRequiredResponse",additionalProperties:false});
export type ListRoutingRequiredResponse=Static<typeof ListRoutingRequiredResponseSchema>;
export const ResolveRoutingRequiredParamsSchema=Type.Object({receiptId:Type.String({format:"uuid"})},{additionalProperties:false});
export type ResolveRoutingRequiredParams=Static<typeof ResolveRoutingRequiredParamsSchema>;
export const ResolveRoutingRequiredRequestSchema=Type.Object({unitId:Type.String({format:"uuid"})},
  { $id:"ResolveRoutingRequiredRequest",additionalProperties:false});
export type ResolveRoutingRequiredRequest=Static<typeof ResolveRoutingRequiredRequestSchema>;
export const ResolveRoutingRequiredResponseSchema=Type.Object({receiptId:Type.String({format:"uuid"}),unitId:Type.String({format:"uuid"}),
  routingStatus:Type.Literal("ROUTED"),replayed:Type.Boolean()},{$id:"ResolveRoutingRequiredResponse",additionalProperties:false});
export type ResolveRoutingRequiredResponse=Static<typeof ResolveRoutingRequiredResponseSchema>;

export const InboxConversationParamsSchema=Type.Object({conversationId:Type.String({format:"uuid"})},{additionalProperties:false});
export type InboxConversationParams=Static<typeof InboxConversationParamsSchema>;
export const InboxConversationActionSchema=Type.Union([Type.Literal("CLAIM_HANDOFF"),Type.Literal("SEND_TEXT"),Type.Literal("RESOLVE_HANDOFF"),Type.Literal("REQUEUE_HANDOFF"),Type.Literal("TRANSFER_HANDOFF"),Type.Literal("TAKEOVER_HANDOFF")]);
export const InboxConversationClaimTargetSchema=Type.Object({handoffId:Type.String({format:"uuid"}),expectedVersion:Type.Integer({minimum:1})},{additionalProperties:false});
export const InboxConversationSchema=Type.Object({conversationId:Type.String({format:"uuid"}),unitId:Type.String({format:"uuid"}),
  channelConnectionId:Type.String({format:"uuid"}),status:Type.Union([Type.Literal("OPEN"),Type.Literal("CLOSED"),Type.Literal("ARCHIVED")]),
  automationStatus:Type.Union([Type.Literal("ACTIVE"),Type.Literal("HUMAN_REQUESTED"),Type.Literal("HUMAN_QUEUED"),Type.Literal("HUMAN_ACTIVE"),Type.Literal("SUSPENDED")]),
  assignedUserId:Type.Union([Type.String({format:"uuid"}),Type.Null()]),version:Type.Integer({minimum:1}),
  updatedAt:Type.String({format:"date-time"}),stateChangedAt:Type.String({format:"date-time"}),closedAt:Type.Union([Type.String({format:"date-time"}),Type.Null()]),
  displayName:Type.Union([Type.String({maxLength:200}),Type.Null()]),allowedActions:Type.Array(InboxConversationActionSchema,{uniqueItems:true}),
  claimTarget:Type.Union([InboxConversationClaimTargetSchema,Type.Null()]),
  sendTextTarget:Type.Union([Type.Object({expectedConversationVersion:Type.Integer({minimum:1})},{additionalProperties:false}),Type.Null()]),
  resolveTarget:Type.Union([InboxConversationClaimTargetSchema,Type.Null()]),
  requeueTarget:Type.Union([InboxConversationClaimTargetSchema,Type.Null()]),
  transferTarget:Type.Union([InboxConversationClaimTargetSchema,Type.Null()]),
  takeoverTarget:Type.Union([InboxConversationClaimTargetSchema,Type.Null()])},{additionalProperties:false});
export type InboxConversation=Static<typeof InboxConversationSchema>;
export const InboxMessageActionSchema=Type.Literal("CANCEL_QUEUED");
export const InboxMessageSchema=Type.Object({id:Type.String({format:"uuid"}),direction:Type.Union([Type.Literal("INBOUND"),Type.Literal("OUTBOUND")]),
  actor:Type.Union([Type.Literal("CUSTOMER"),Type.Literal("HERMES"),Type.Literal("HUMAN"),Type.Literal("SYSTEM")]),
  body:Type.Union([Type.String({maxLength:32000}),Type.Null()]),kind:Type.Union([Type.Literal("TEXT"),Type.Literal("AUDIO"),Type.Literal("IMAGE"),Type.Literal("DOCUMENT"),Type.Literal("INTERACTIVE"),Type.Literal("UNKNOWN")]),
  trust:Type.Union([Type.Literal("UNTRUSTED"),Type.Null()]),deliveryStatus:Type.Union([Type.Literal("QUEUED"),Type.Literal("SENT"),Type.Literal("DELIVERED"),Type.Literal("READ"),Type.Literal("FAILED"),Type.Literal("CANCELLED"),Type.Null()]),
  allowedActions:Type.Array(InboxMessageActionSchema,{uniqueItems:true}),createdAt:Type.String({format:"date-time"})},{additionalProperties:false});
export type InboxMessage=Static<typeof InboxMessageSchema>;
export const ListInboxMessagesQuerySchema=Type.Object({limit:Type.Optional(Type.Integer({minimum:1,maximum:100,default:25})),cursor:Type.Optional(Type.String({minLength:1,maxLength:1024})),
  before:Type.Optional(Type.String({format:"date-time"}))},{additionalProperties:false});
export type ListInboxMessagesQuery=Static<typeof ListInboxMessagesQuerySchema>;
export const ListInboxMessagesResponseSchema=Type.Object({items:Type.Array(InboxMessageSchema),nextCursor:Type.Optional(Type.String({minLength:1,maxLength:1024}))},{additionalProperties:false});
export type ListInboxMessagesResponse=Static<typeof ListInboxMessagesResponseSchema>;
export const SendHumanTextMessageRequestSchema=Type.Object({kind:Type.Literal("TEXT"),body:Type.String({minLength:1,maxLength:4096}),
  expectedConversationVersion:Type.Integer({minimum:1})},{additionalProperties:false});
export type SendHumanTextMessageRequest=Static<typeof SendHumanTextMessageRequestSchema>;
export const SendHumanTextMessageResponseSchema=Type.Object({messageId:Type.String({format:"uuid"}),conversationId:Type.String({format:"uuid"}),
  conversationVersion:Type.Integer({minimum:1}),deliveryStatus:Type.Literal("QUEUED"),replayed:Type.Boolean()},{additionalProperties:false});
export type SendHumanTextMessageResponse=Static<typeof SendHumanTextMessageResponseSchema>;
export const InboxMessageParamsSchema=Type.Object({conversationId:Type.String({format:"uuid"}),messageId:Type.String({format:"uuid"})},{additionalProperties:false});
export type InboxMessageParams=Static<typeof InboxMessageParamsSchema>;
export const CancelHumanTextMessageRequestSchema=Type.Object({expectedConversationVersion:Type.Integer({minimum:1})},{additionalProperties:false});
export type CancelHumanTextMessageRequest=Static<typeof CancelHumanTextMessageRequestSchema>;
export const CancelHumanTextMessageResponseSchema=Type.Object({messageId:Type.String({format:"uuid"}),conversationId:Type.String({format:"uuid"}),
  conversationVersion:Type.Integer({minimum:1}),deliveryStatus:Type.Literal("CANCELLED"),replayed:Type.Boolean()},{additionalProperties:false});
export type CancelHumanTextMessageResponse=Static<typeof CancelHumanTextMessageResponseSchema>;
export const InboxAvailabilityStatusSchema=Type.Union([Type.Literal("AVAILABLE"),Type.Literal("PAUSED"),Type.Literal("OFFLINE")],{$id:"InboxAvailabilityStatus"});
export const InboxAvailabilityPauseReasonSchema=Type.Union([Type.Literal("BREAK"),Type.Literal("TRAINING"),Type.Literal("MEETING"),Type.Literal("OTHER_OPERATIONAL")],{$id:"InboxAvailabilityPauseReason"});
export const InboxAvailabilityQuerySchema=Type.Object({unitId:Type.String({format:"uuid"})},{additionalProperties:false});
export type InboxAvailabilityQuery=Static<typeof InboxAvailabilityQuerySchema>;
export const InboxAvailabilitySchema=Type.Object({unitId:Type.String({format:"uuid"}),userId:Type.String({format:"uuid"}),status:InboxAvailabilityStatusSchema,
  maxActive:Type.Integer({minimum:1,maximum:100}),pauseReason:Type.Union([InboxAvailabilityPauseReasonSchema,Type.Null()]),
  pausedUntil:Type.Union([Type.String({format:"date-time"}),Type.Null()]),activeCount:Type.Integer({minimum:0}),version:Type.Integer({minimum:1}),
  updatedAt:Type.String({format:"date-time"})},{$id:"InboxAvailability",additionalProperties:false});
export type InboxAvailability=Static<typeof InboxAvailabilitySchema>;
export const SetInboxAvailabilityRequestSchema=Type.Object({unitId:Type.String({format:"uuid"}),status:InboxAvailabilityStatusSchema,
  maxActive:Type.Integer({minimum:1,maximum:100}),pauseReason:Type.Optional(Type.Union([InboxAvailabilityPauseReasonSchema,Type.Null()])),
  pausedUntil:Type.Optional(Type.Union([Type.String({format:"date-time"}),Type.Null()])),expectedVersion:Type.Integer({minimum:1})},
{additionalProperties:false});
export type SetInboxAvailabilityRequest=Static<typeof SetInboxAvailabilityRequestSchema>;
export const SetInboxAvailabilityResponseSchema=Type.Object({unitId:Type.String({format:"uuid"}),userId:Type.String({format:"uuid"}),status:InboxAvailabilityStatusSchema,
  maxActive:Type.Integer({minimum:1,maximum:100}),pauseReason:Type.Union([InboxAvailabilityPauseReasonSchema,Type.Null()]),pausedUntil:Type.Union([Type.String({format:"date-time"}),Type.Null()]),
  activeCount:Type.Integer({minimum:0}),version:Type.Integer({minimum:1}),updatedAt:Type.String({format:"date-time"}),replayed:Type.Boolean()},{$id:"SetInboxAvailabilityResponse",additionalProperties:false});
export type SetInboxAvailabilityResponse=Static<typeof SetInboxAvailabilityResponseSchema>;
export const ListInboxTeamAvailabilityQuerySchema=Type.Object({unitId:Type.String({format:"uuid"}),limit:Type.Optional(Type.Integer({minimum:1,maximum:100,default:25})),
  status:Type.Optional(InboxAvailabilityStatusSchema),cursor:Type.Optional(Type.String({minLength:1,maxLength:1024}))},{$id:"ListInboxTeamAvailabilityQuery",additionalProperties:false});
export type ListInboxTeamAvailabilityQuery=Static<typeof ListInboxTeamAvailabilityQuerySchema>;
export const InboxTeamAvailabilityItemSchema=Type.Object({userId:Type.String({format:"uuid"}),displayName:Type.String({minLength:1,maxLength:160}),
  role:Type.Union([Type.Literal("TENANT_ADMIN"),Type.Literal("UNIT_MANAGER"),Type.Literal("SUPERVISOR"),Type.Literal("ATTENDANT")]),status:InboxAvailabilityStatusSchema,
  maxActive:Type.Integer({minimum:1,maximum:100}),activeCount:Type.Integer({minimum:0}),remainingCapacity:Type.Integer({minimum:0}),
  pauseReason:Type.Union([InboxAvailabilityPauseReasonSchema,Type.Null()]),pausedUntil:Type.Union([Type.String({format:"date-time"}),Type.Null()]),updatedAt:Type.String({format:"date-time"})},
{$id:"InboxTeamAvailabilityItem",additionalProperties:false});
export type InboxTeamAvailabilityItem=Static<typeof InboxTeamAvailabilityItemSchema>;
export const ListInboxTeamAvailabilityResponseSchema=Type.Object({items:Type.Array(InboxTeamAvailabilityItemSchema),
  nextCursor:Type.Optional(Type.String({minLength:1,maxLength:1024}))},{$id:"ListInboxTeamAvailabilityResponse",additionalProperties:false});
export type ListInboxTeamAvailabilityResponse=Static<typeof ListInboxTeamAvailabilityResponseSchema>;
export const SlaAlertSeveritySchema=Type.Union([Type.Literal("MISSING_SLA"),Type.Literal("DUE_SOON"),Type.Literal("OVERDUE")],{$id:"SlaAlertSeverity"});
export const ListInboxSlaAlertsQuerySchema=Type.Object({unitId:Type.String({format:"uuid"}),limit:Type.Optional(Type.Integer({minimum:1,maximum:100,default:25})),severity:Type.Optional(SlaAlertSeveritySchema),priority:Type.Optional(HandoffPrioritySchema),cursor:Type.Optional(Type.String({minLength:1,maxLength:1024}))},{additionalProperties:false});
export type ListInboxSlaAlertsQuery=Static<typeof ListInboxSlaAlertsQuerySchema>;
export const InboxSlaAlertSchema=Type.Object({handoffId:Type.String({format:"uuid"}),unitId:Type.String({format:"uuid"}),priority:HandoffPrioritySchema,severity:SlaAlertSeveritySchema,slaDueAt:Type.Union([Type.String({format:"date-time"}),Type.Null()]),queuedAt:Type.String({format:"date-time"}),ageSeconds:Type.Integer({minimum:0}),availableCapacity:Type.Integer({minimum:0}),acknowledgedAt:Type.Union([Type.String({format:"date-time"}),Type.Null()]),version:Type.Integer({minimum:1})},{additionalProperties:false});
export const ListInboxSlaAlertsResponseSchema=Type.Object({items:Type.Array(InboxSlaAlertSchema),nextCursor:Type.Optional(Type.String({minLength:1,maxLength:1024}))},{$id:"ListInboxSlaAlertsResponse",additionalProperties:false});
export type ListInboxSlaAlertsResponse=Static<typeof ListInboxSlaAlertsResponseSchema>;
export const AcknowledgeInboxSlaAlertParamsSchema=Type.Object({handoffId:Type.String({format:"uuid"})},{additionalProperties:false});
export const AcknowledgeInboxSlaAlertRequestSchema=Type.Object({expectedVersion:Type.Integer({minimum:1})},{additionalProperties:false});
export type AcknowledgeInboxSlaAlertRequest=Static<typeof AcknowledgeInboxSlaAlertRequestSchema>;
export const AcknowledgeInboxSlaAlertResponseSchema=Type.Object({handoffId:Type.String({format:"uuid"}),acknowledgedAt:Type.String({format:"date-time"}),acknowledgedByUserId:Type.String({format:"uuid"}),version:Type.Integer({minimum:1}),replayed:Type.Boolean()},{$id:"AcknowledgeInboxSlaAlertResponse",additionalProperties:false});
export type AcknowledgeInboxSlaAlertResponse=Static<typeof AcknowledgeInboxSlaAlertResponseSchema>;
export const UnitSlaPolicyParamsSchema=Type.Object({unitId:Type.String({format:"uuid"})},{additionalProperties:false});
export const UnitSlaTargetSchema=Type.Object({priority:HandoffPrioritySchema,targetMinutes:Type.Integer({minimum:1,maximum:10080})},{additionalProperties:false});
export type UnitSlaTarget=Static<typeof UnitSlaTargetSchema>;
export const UnitSlaPolicySchema=Type.Object({unitId:Type.String({format:"uuid"}),version:Type.Integer({minimum:1}),effectiveAt:Type.String({format:"date-time"}),targets:Type.Array(UnitSlaTargetSchema,{minItems:4,maxItems:4})},{additionalProperties:false});
export type UnitSlaPolicy=Static<typeof UnitSlaPolicySchema>;
export const SetUnitSlaPolicyRequestSchema=Type.Object({expectedVersion:Type.Integer({minimum:0}),targets:Type.Array(UnitSlaTargetSchema,{minItems:4,maxItems:4})},{additionalProperties:false});
export type SetUnitSlaPolicyRequest=Static<typeof SetUnitSlaPolicyRequestSchema>;
export const SetUnitSlaPolicyResponseSchema=Type.Composite([UnitSlaPolicySchema,Type.Object({replayed:Type.Boolean()},{additionalProperties:false})],{additionalProperties:false});
export type SetUnitSlaPolicyResponse=Static<typeof SetUnitSlaPolicyResponseSchema>;
export const UnitOperationalTimezoneParamsSchema=Type.Object({unitId:Type.String({format:"uuid"})},{additionalProperties:false});
export const OperationalTimezoneNameSchema=Type.String({minLength:1,maxLength:100,pattern:"^[^\\s]+$"});
export const UnitOperationalTimezoneSchema=Type.Object({unitId:Type.String({format:"uuid"}),timeZone:OperationalTimezoneNameSchema,version:Type.Integer({minimum:1}),updatedAt:Type.String({format:"date-time"})},{additionalProperties:false});
export type UnitOperationalTimezone=Static<typeof UnitOperationalTimezoneSchema>;
export const SetUnitOperationalTimezoneRequestSchema=Type.Object({expectedVersion:Type.Integer({minimum:0}),timeZone:OperationalTimezoneNameSchema},{additionalProperties:false});
export type SetUnitOperationalTimezoneRequest=Static<typeof SetUnitOperationalTimezoneRequestSchema>;
export const SetUnitOperationalTimezoneResponseSchema=Type.Composite([UnitOperationalTimezoneSchema,Type.Object({replayed:Type.Boolean()},{additionalProperties:false})],{additionalProperties:false});
export type SetUnitOperationalTimezoneResponse=Static<typeof SetUnitOperationalTimezoneResponseSchema>;
export const StaffScheduleParamsSchema=Type.Object({unitId:Type.String({format:"uuid"}),userId:Type.String({format:"uuid"})},{additionalProperties:false});
export const ShiftSlotSchema=Type.Object({weekday:Type.Integer({minimum:1,maximum:7}),start:Type.String({pattern:"^(?:[01]\\d|2[0-3]):[0-5]\\d$"}),end:Type.String({pattern:"^(?:[01]\\d|2[0-3]):[0-5]\\d$"})},{additionalProperties:false});
export const ShiftExceptionSlotSchema=Type.Object({start:Type.String({pattern:"^(?:[01]\\d|2[0-3]):[0-5]\\d$"}),end:Type.String({pattern:"^(?:[01]\\d|2[0-3]):[0-5]\\d$"})},{additionalProperties:false});
export const ShiftExceptionSchema=Type.Union([Type.Object({date:Type.String({format:"date"}),type:Type.Literal("CLOSED")},{additionalProperties:false}),Type.Object({date:Type.String({format:"date"}),type:Type.Literal("REPLACE"),slots:Type.Array(ShiftExceptionSlotSchema,{minItems:1,maxItems:4})},{additionalProperties:false})]);
export const StaffScheduleSchema=Type.Object({unitId:Type.String({format:"uuid"}),userId:Type.String({format:"uuid"}),timeZone:OperationalTimezoneNameSchema,effectiveFrom:Type.String({format:"date"}),weeklySlots:Type.Array(ShiftSlotSchema,{maxItems:28}),exceptions:Type.Array(ShiftExceptionSchema,{maxItems:90}),version:Type.Integer({minimum:1}),updatedAt:Type.String({format:"date-time"})},{additionalProperties:false});
export type StaffSchedule=Static<typeof StaffScheduleSchema>;
export const SetStaffScheduleRequestSchema=Type.Object({expectedVersion:Type.Integer({minimum:0}),effectiveFrom:Type.String({format:"date"}),weeklySlots:Type.Array(ShiftSlotSchema,{maxItems:28}),exceptions:Type.Array(ShiftExceptionSchema,{maxItems:90})},{additionalProperties:false});
export type SetStaffScheduleRequest=Static<typeof SetStaffScheduleRequestSchema>;
export const SetStaffScheduleResponseSchema=Type.Composite([StaffScheduleSchema,Type.Object({replayed:Type.Boolean()},{additionalProperties:false})],{additionalProperties:false});
export type SetStaffScheduleResponse=Static<typeof SetStaffScheduleResponseSchema>;
export const ShiftMemberSchema=Type.Object({userId:Type.String({format:"uuid"}),displayName:Type.String({minLength:1,maxLength:160}),role:AppRoleSchema},{additionalProperties:false});
export const ListShiftMembersResponseSchema=Type.Object({items:Type.Array(ShiftMemberSchema)},{additionalProperties:false});
export type ListShiftMembersResponse=Static<typeof ListShiftMembersResponseSchema>;
export const HandoffResolutionDispositionSchema=Type.Union([
  Type.Literal("RESOLVED"),Type.Literal("DUPLICATE"),Type.Literal("CUSTOMER_WITHDREW"),Type.Literal("EXTERNAL_REFERRAL"),
],{$id:"HandoffResolutionDisposition"});
export type HandoffResolutionDisposition=Static<typeof HandoffResolutionDispositionSchema>;
export const ResolveHandoffRequestSchema=Type.Object({expectedVersion:Type.Integer({minimum:1}),
  disposition:HandoffResolutionDispositionSchema},{additionalProperties:false});
export type ResolveHandoffRequest=Static<typeof ResolveHandoffRequestSchema>;
export const ResolveHandoffResponseSchema=Type.Object({handoffId:Type.String({format:"uuid"}),conversationId:Type.String({format:"uuid"}),
  serviceCaseId:Type.String({format:"uuid"}),handoffVersion:Type.Integer({minimum:1}),conversationVersion:Type.Integer({minimum:1}),replayed:Type.Boolean()},
  {$id:"ResolveHandoffResponse",additionalProperties:false});
export type ResolveHandoffResponse=Static<typeof ResolveHandoffResponseSchema>;
export const RequeueHandoffRequestSchema=Type.Object({expectedVersion:Type.Integer({minimum:1})},{additionalProperties:false});
export type RequeueHandoffRequest=Static<typeof RequeueHandoffRequestSchema>;
export const RequeueHandoffResponseSchema=Type.Object({handoffId:Type.String({format:"uuid"}),conversationId:Type.String({format:"uuid"}),
  serviceCaseId:Type.String({format:"uuid"}),handoffVersion:Type.Integer({minimum:1}),conversationVersion:Type.Integer({minimum:1}),
  serviceCaseVersion:Type.Integer({minimum:1}),replayed:Type.Boolean()},{$id:"RequeueHandoffResponse",additionalProperties:false});
export type RequeueHandoffResponse=Static<typeof RequeueHandoffResponseSchema>;
export const ReopenReasonSchema=Type.Union([Type.Literal("FOLLOW_UP_REQUIRED"),Type.Literal("PREMATURE_CLOSURE"),
  Type.Literal("NEW_INFORMATION"),Type.Literal("OPERATIONAL_CORRECTION")],{$id:"ReopenReason"});
export type ReopenReason=Static<typeof ReopenReasonSchema>;
export const ReopenHandoffRequestSchema=Type.Object({expectedVersion:Type.Integer({minimum:1}),reason:ReopenReasonSchema},
  {$id:"ReopenHandoffRequest",additionalProperties:false});
export type ReopenHandoffRequest=Static<typeof ReopenHandoffRequestSchema>;
export const ReopenHandoffResponseSchema=Type.Object({sourceHandoffId:Type.String({format:"uuid"}),handoffId:Type.String({format:"uuid"}),
  conversationId:Type.String({format:"uuid"}),serviceCaseId:Type.String({format:"uuid"}),handoffVersion:Type.Integer({minimum:1}),
  conversationVersion:Type.Integer({minimum:1}),serviceCaseVersion:Type.Integer({minimum:1}),replayed:Type.Boolean()},
  {$id:"ReopenHandoffResponse",additionalProperties:false});
export type ReopenHandoffResponse=Static<typeof ReopenHandoffResponseSchema>;
export const InboxTransferCandidateSchema=Type.Object({id:Type.String({format:"uuid"}),displayName:Type.String({minLength:1,maxLength:160})},{additionalProperties:false});
export const ListInboxTransferCandidatesResponseSchema=Type.Object({items:Type.Array(InboxTransferCandidateSchema)},{additionalProperties:false});
export type ListInboxTransferCandidatesResponse=Static<typeof ListInboxTransferCandidatesResponseSchema>;
export const TransferReasonSchema=Type.Union([
  Type.Literal("SHIFT_CHANGE"),Type.Literal("LOAD_BALANCING"),Type.Literal("SPECIALIZED_SUPPORT"),Type.Literal("OPERATIONAL_CONTINUITY"),
],{$id:"TransferReason"});
export type TransferReason=Static<typeof TransferReasonSchema>;
export const TransferHandoffRequestSchema=Type.Object({expectedVersion:Type.Integer({minimum:1}),targetUserId:Type.String({format:"uuid"}),reason:TransferReasonSchema},{additionalProperties:false});
export type TransferHandoffRequest=Static<typeof TransferHandoffRequestSchema>;
export const TransferHandoffResponseSchema=Type.Object({handoffId:Type.String({format:"uuid"}),conversationId:Type.String({format:"uuid"}),
  serviceCaseId:Type.String({format:"uuid"}),targetUserId:Type.String({format:"uuid"}),handoffVersion:Type.Integer({minimum:1}),
  conversationVersion:Type.Integer({minimum:1}),replayed:Type.Boolean()},{$id:"TransferHandoffResponse",additionalProperties:false});
export type TransferHandoffResponse=Static<typeof TransferHandoffResponseSchema>;
export const TakeoverHandoffRequestSchema=Type.Object({expectedVersion:Type.Integer({minimum:1})},{additionalProperties:false});
export type TakeoverHandoffRequest=Static<typeof TakeoverHandoffRequestSchema>;
export const TakeoverHandoffResponseSchema=Type.Object({handoffId:Type.String({format:"uuid"}),conversationId:Type.String({format:"uuid"}),
  serviceCaseId:Type.String({format:"uuid"}),previousAssignedUserId:Type.String({format:"uuid"}),handoffVersion:Type.Integer({minimum:1}),
  conversationVersion:Type.Integer({minimum:1}),replayed:Type.Boolean()},{$id:"TakeoverHandoffResponse",additionalProperties:false});
export type TakeoverHandoffResponse=Static<typeof TakeoverHandoffResponseSchema>;
