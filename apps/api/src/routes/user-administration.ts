import type { FastifyInstance } from "fastify";
import { AdministrativeInvitationsPageSchema, AdministrativeUsersPageSchema, ChangeUserStatusRequestSchema,
  ChangeUserStatusResponseSchema,ChangeUnitMembershipParamsSchema,ChangeUnitMembershipRequestSchema,
  ChangeUnitMembershipResponseSchema, ProblemDetailsSchema, ReissueInvitationRequestSchema,
  ReissueInvitationResponseSchema, RevokeInvitationRequestSchema, RevokeInvitationResponseSchema,
  ListUnitMembershipsParamsSchema,ListUnitMembershipsQuerySchema,UnitMembershipsPageSchema,
  type ChangeUserStatusRequest,type ChangeUnitMembershipParams,type ChangeUnitMembershipRequest,
  type ListUnitMembershipsParams,type ListUnitMembershipsQuery,type ReissueInvitationRequest, type RevokeInvitationRequest } from "@zap-pronto/contracts";
import { changeAdministrativeUserStatus,changeUnitMembership, listAdministrativeInvitations, listAdministrativeUsers,
  listUnitMembershipCatalog,reissueUserInvitation, revokeUserInvitation } from "@zap-pronto/core/domain/user-administration";
import type { TenantTransactionPool } from "@zap-pronto/core/database/tenant-transaction";
import { protectedRoute } from "../http/protected-route.js";
import { InvitationRequestError } from "./user-invitations-errors.js";

interface PageQuery { limit?: number; cursor?: string }
const pageQuerySchema = { type: "object", additionalProperties: false, properties: {
  limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
  cursor: { type: "string", minLength: 1, maxLength: 1024 },
} } as const;
const idempotencyHeaders = { type: "object", required: ["idempotency-key"], properties: {
  "idempotency-key": { type: "string", minLength: 8, maxLength: 200 },
} } as const;
const userParams = { type: "object", required: ["userId"], properties: {
  userId: { type: "string", format: "uuid" },
} } as const;
const invitationParams = { type: "object", required: ["invitationId"], properties: {
  invitationId: { type: "string", format: "uuid" },
} } as const;

function idempotencyKey(headers: Record<string, unknown>): string {
  const value = headers["idempotency-key"];
  if (typeof value !== "string") throw new Error("INVALID_IDEMPOTENCY_KEY");
  return value;
}
function invitationView(item: Awaited<ReturnType<typeof revokeUserInvitation>>) {
  return { id: item.id, email: item.email, displayName: item.displayName, status: item.status,
    expiresAt: item.expiresAt.toISOString(), providerCode: item.providerCode,
    assignments: item.assignments, allowedActions: item.allowedActions };
}

export function registerUserAdministrationRoutes(app: FastifyInstance, pool: TenantTransactionPool): void {
  app.get<{ Querystring: PageQuery }>("/v1/users", protectedRoute({
    pool, authorization: { kind: "permission", permission: "tenant.users.manage", scope: { kind: "tenant" } },
    schema: { operationId: "listAdministrativeUsers", querystring: pageQuerySchema,
      response: { 200: AdministrativeUsersPageSchema, 400: ProblemDetailsSchema, 401: ProblemDetailsSchema,
        403: ProblemDetailsSchema, 500: ProblemDetailsSchema, 503: ProblemDetailsSchema } },
    async handler(client, request, reply) {
      try {
        void reply.header("cache-control", "no-store");
        return await listAdministrativeUsers(client, request.query as PageQuery);
      } catch (error) { throw InvitationRequestError.from(error); }
    },
  }));
  app.get<{ Querystring: PageQuery }>("/v1/users/invitations", protectedRoute({
    pool, authorization: { kind: "permission", permission: "tenant.users.manage", scope: { kind: "tenant" } },
    schema: { operationId: "listAdministrativeInvitations", querystring: pageQuerySchema,
      response: { 200: AdministrativeInvitationsPageSchema, 400: ProblemDetailsSchema, 401: ProblemDetailsSchema,
        403: ProblemDetailsSchema, 500: ProblemDetailsSchema, 503: ProblemDetailsSchema } },
    async handler(client, request, reply) {
      try {
        void reply.header("cache-control", "no-store");
        const page = await listAdministrativeInvitations(client, request.query as PageQuery);
        return { ...page, items: page.items.map((item) => ({ ...item, expiresAt: item.expiresAt.toISOString() })) };
      } catch (error) { throw InvitationRequestError.from(error); }
    },
  }));

  app.get<{Params:ListUnitMembershipsParams;Querystring:ListUnitMembershipsQuery}>("/v1/units/:unitId/memberships",protectedRoute({
    pool,noStore:true,
    authorization:{kind:"permission",permission:"unit.members.manage",scope:{kind:"unit",
      async resolveUnitId(_client,request){return(request.params as ListUnitMembershipsParams).unitId}}},
    schema:{operationId:"listUnitMemberships",params:ListUnitMembershipsParamsSchema,
      querystring:ListUnitMembershipsQuerySchema,response:{200:UnitMembershipsPageSchema,
        400:ProblemDetailsSchema,401:ProblemDetailsSchema,403:ProblemDetailsSchema,
        500:ProblemDetailsSchema,503:ProblemDetailsSchema}},
    async handler(client,request){
      try{const params=request.params as ListUnitMembershipsParams;
        const query=request.query as ListUnitMembershipsQuery;
        return await listUnitMembershipCatalog(client,{unitId:params.unitId,...query})}
      catch(error){throw InvitationRequestError.from(error)}
    },
  }));

  app.post("/v1/users/:userId/status", protectedRoute({
    pool, authorization: { kind: "permission", permission: "tenant.users.manage", scope: { kind: "tenant" } },
    schema: { operationId: "changeAdministrativeUserStatus", params: userParams, headers: idempotencyHeaders,
      body: ChangeUserStatusRequestSchema, response: { 200: ChangeUserStatusResponseSchema,
        400: ProblemDetailsSchema, 401: ProblemDetailsSchema, 403: ProblemDetailsSchema, 404: ProblemDetailsSchema,
        409: ProblemDetailsSchema, 500: ProblemDetailsSchema, 503: ProblemDetailsSchema } },
    async handler(client, request, reply) {
      try {
        const body = request.body as ChangeUserStatusRequest; const params = request.params as { userId: string };
        const result = await changeAdministrativeUserStatus(client, { ...body, userId: params.userId,
          idempotencyKey: idempotencyKey(request.headers) });
        void reply.header("cache-control", "no-store");
        return { user: { id: result.id, status: result.status, version: result.version }, replayed: result.replayed };
      } catch (error) { throw InvitationRequestError.from(error); }
    },
  }));
  app.post("/v1/users/:userId/memberships/:unitId/lifecycle",protectedRoute({pool,noStore:true,
    authorization:{kind:"permission",permission:"unit.members.manage",scope:{kind:"unit",async resolveUnitId(_client,request){return(request.params as ChangeUnitMembershipParams).unitId}}},
    schema:{operationId:"changeUnitMembership",params:ChangeUnitMembershipParamsSchema,headers:idempotencyHeaders,
      body:ChangeUnitMembershipRequestSchema,response:{200:ChangeUnitMembershipResponseSchema,400:ProblemDetailsSchema,401:ProblemDetailsSchema,
        403:ProblemDetailsSchema,404:ProblemDetailsSchema,409:ProblemDetailsSchema,500:ProblemDetailsSchema,503:ProblemDetailsSchema}},
    async handler(client,request){try{const params=request.params as ChangeUnitMembershipParams,body=request.body as ChangeUnitMembershipRequest;
      const result=await changeUnitMembership(client,{...params,...body,idempotencyKey:idempotencyKey(request.headers)});
      return{membership:{userId:result.userId,unitId:result.unitId,status:result.status,version:result.version},replayed:result.replayed};
    }catch(error){throw InvitationRequestError.from(error)}}}));
  app.post("/v1/users/invitations/:invitationId/revoke", protectedRoute({
    pool, authorization: { kind: "permission", permission: "tenant.users.manage", scope: { kind: "tenant" } },
    schema: { operationId: "revokeUserInvitation", params: invitationParams, headers: idempotencyHeaders,
      body: RevokeInvitationRequestSchema, response: { 200: RevokeInvitationResponseSchema,
        400: ProblemDetailsSchema, 401: ProblemDetailsSchema, 403: ProblemDetailsSchema, 404: ProblemDetailsSchema,
        409: ProblemDetailsSchema, 500: ProblemDetailsSchema, 503: ProblemDetailsSchema } },
    async handler(client, request, reply) {
      try {
        const body = request.body as RevokeInvitationRequest; const params = request.params as { invitationId: string };
        const result = await revokeUserInvitation(client, { ...body, invitationId: params.invitationId,
          idempotencyKey: idempotencyKey(request.headers) });
        void reply.header("cache-control", "no-store");
        return { invitation: invitationView(result), replayed: result.replayed };
      } catch (error) { throw InvitationRequestError.from(error); }
    },
  }));
  app.post("/v1/users/invitations/:invitationId/reissue", protectedRoute({
    pool, authorization: { kind: "permission", permission: "tenant.users.manage", scope: { kind: "tenant" } },
    schema: { operationId: "reissueUserInvitation", params: invitationParams, headers: idempotencyHeaders,
      body: ReissueInvitationRequestSchema, response: { 200: ReissueInvitationResponseSchema, 201: ReissueInvitationResponseSchema,
        400: ProblemDetailsSchema, 401: ProblemDetailsSchema, 403: ProblemDetailsSchema, 404: ProblemDetailsSchema,
        409: ProblemDetailsSchema, 500: ProblemDetailsSchema, 503: ProblemDetailsSchema } },
    async handler(client, request, reply) {
      try {
        const body = request.body as ReissueInvitationRequest; const params = request.params as { invitationId: string };
        const result = await reissueUserInvitation(client, { invitationId: params.invitationId, reason: body.reason,
          expiresAt: new Date(body.expiresAt), idempotencyKey: idempotencyKey(request.headers) });
        void reply.header("cache-control", "no-store"); void reply.status(result.replayed ? 200 : 201);
        return { invitation: invitationView(result), replayed: result.replayed,
          ...(!result.replayed && result.token ? { invitationToken: result.token } : {}) };
      } catch (error) { throw InvitationRequestError.from(error); }
    },
  }));
}
