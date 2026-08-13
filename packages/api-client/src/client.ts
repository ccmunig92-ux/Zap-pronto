import createClient from "openapi-fetch";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { AcceptUserInvitationResponseSchema, AdministrativeInvitationsPageSchema, AdministrativeUsersPageSchema, ChangeUserStatusResponseSchema,
  CreateUserInvitationResponseSchema, CurrentUserSchema, ProblemDetailsSchema, ReissueInvitationResponseSchema,ChangeUnitMembershipResponseSchema,UnitMembershipsPageSchema,
  RevokeInvitationResponseSchema,
  InboxAvailabilitySchema,SetInboxAvailabilityResponseSchema,ListInboxSlaAlertsResponseSchema,AcknowledgeInboxSlaAlertResponseSchema,
  ListRoutingRequiredResponseSchema,ResolveRoutingRequiredResponseSchema,InboxConversationSchema,ListInboxMessagesResponseSchema,ListHandoffsResponseSchema,ListResolvedHandoffsResponseSchema,ClaimHandoffResponseSchema,ResolveHandoffResponseSchema,RequeueHandoffResponseSchema,ReopenHandoffResponseSchema,ListInboxTransferCandidatesResponseSchema,TransferHandoffResponseSchema,TakeoverHandoffResponseSchema,SendHumanTextMessageResponseSchema,CancelHumanTextMessageResponseSchema,
  UserInvitationOptionsSchema, type CreateUserInvitationRequest, type CreateUserInvitationResponse,
  type AcceptUserInvitationResponse, type AdministrativeInvitationsPage, type AdministrativeUsersPage, type ChangeUserStatusRequest,
  type ChangeUserStatusResponse,type ChangeUnitMembershipRequest,type ChangeUnitMembershipResponse,type UnitMembershipsPage, type CurrentUser, type ProblemDetails, type ReissueInvitationRequest,
  type ReissueInvitationResponse, type RevokeInvitationRequest, type RevokeInvitationResponse,
  type ListInboxSlaAlertsResponse,type AcknowledgeInboxSlaAlertResponse,type UserInvitationOptions,type ListRoutingRequiredResponse,type ResolveRoutingRequiredResponse,type InboxConversation,type ListInboxMessagesResponse,type ListHandoffsResponse,type ListResolvedHandoffsResponse,type ClaimHandoffResponse,type ResolveHandoffResponse,type RequeueHandoffResponse,type ReopenHandoffResponse,type ListInboxTransferCandidatesResponse,type TransferHandoffResponse,type TakeoverHandoffResponse,type SendHumanTextMessageResponse,type CancelHumanTextMessageResponse,type InboxAvailability,type SetInboxAvailabilityRequest,type SetInboxAvailabilityResponse } from "@zap-pronto/contracts";
import type { paths } from "./generated.js";

if (!FormatRegistry.Has("uuid")) FormatRegistry.Set("uuid", (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
if (!FormatRegistry.Has("date-time")) FormatRegistry.Set("date-time", (value) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value)));

export class ApiProblem extends Error {
  constructor(readonly problem: ProblemDetails, readonly retryAfterSeconds?: number) {
    super(problem.title); this.name = "ApiProblem";
  }
}
export class AuthenticationRequired extends Error {
  constructor() { super("Authentication is required"); this.name = "AuthenticationRequired"; }
}
export class InvalidApiResponse extends Error {
  constructor() { super("The API returned an invalid response"); this.name = "InvalidApiResponse"; }
}
export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly getAccessToken: () => Promise<string | undefined>;
  readonly fetch?: (request: Request) => Promise<Response>;
}
function mapFailure(error: unknown, response: Response): never {
  if (Value.Check(ProblemDetailsSchema, error)) {
    if (error.status === 401) throw new AuthenticationRequired();
    const retryHeader = response.headers.get("retry-after");
    const retryAfterSeconds = retryHeader && /^\d+$/.test(retryHeader) ? Number(retryHeader) : undefined;
    throw new ApiProblem(error, retryAfterSeconds && retryAfterSeconds > 0 ? retryAfterSeconds : undefined);
  }
  throw new InvalidApiResponse();
}
export function createApiClient(options: ApiClientOptions) {
  const client = createClient<paths>({ baseUrl: options.baseUrl, ...(options.fetch ? { fetch: options.fetch } : {}) });
  return { async getCurrentUser(): Promise<CurrentUser> {
    const token = await options.getAccessToken();
    if (!token) throw new AuthenticationRequired();
    const { data, error, response } = await client.GET("/v1/me", {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!response.ok) {
      mapFailure(error, response);
    }
    if (!Value.Check(CurrentUserSchema, data)) throw new InvalidApiResponse();
    return data;
  }, async getUserInvitationOptions(): Promise<UserInvitationOptions> {
    const token = await options.getAccessToken();
    if (!token) throw new AuthenticationRequired();
    const { data, error, response } = await client.GET("/v1/users/invitations/options", {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!response.ok) mapFailure(error, response);
    if (!Value.Check(UserInvitationOptionsSchema, data)) throw new InvalidApiResponse();
    return data;
  }, async createUserInvitation(input: CreateUserInvitationRequest, idempotencyKey: string): Promise<CreateUserInvitationResponse> {
    const token = await options.getAccessToken();
    if (!token) throw new AuthenticationRequired();
    const { data, error, response } = await client.POST("/v1/users/invitations", {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      params: { header: { "idempotency-key": idempotencyKey } },
      body: input,
    });
    if (!response.ok) mapFailure(error, response);
    if (!Value.Check(CreateUserInvitationResponseSchema, data)) throw new InvalidApiResponse();
    return data;
  }, async listAdministrativeUsers(input: { limit?: number; cursor?: string } = {}): Promise<AdministrativeUsersPage> {
    const token = await options.getAccessToken(); if (!token) throw new AuthenticationRequired();
    const { data, error, response } = await client.GET("/v1/users", { params: { query: input },
      headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    if (!response.ok) mapFailure(error, response);
    if (!Value.Check(AdministrativeUsersPageSchema, data)) throw new InvalidApiResponse(); return data;
  }, async listAdministrativeInvitations(input: { limit?: number; cursor?: string } = {}): Promise<AdministrativeInvitationsPage> {
    const token = await options.getAccessToken(); if (!token) throw new AuthenticationRequired();
    const { data, error, response } = await client.GET("/v1/users/invitations", { params: { query: input },
      headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    if (!response.ok) mapFailure(error, response);
    if (!Value.Check(AdministrativeInvitationsPageSchema, data)) throw new InvalidApiResponse(); return data;
  }, async changeAdministrativeUserStatus(userId: string, input: ChangeUserStatusRequest,
    idempotencyKey: string): Promise<ChangeUserStatusResponse> {
    const token = await options.getAccessToken(); if (!token) throw new AuthenticationRequired();
    const { data, error, response } = await client.POST("/v1/users/{userId}/status", { params: {
      path: { userId }, header: { "idempotency-key": idempotencyKey } }, body: input,
      headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    if (!response.ok) mapFailure(error, response);
    if (!Value.Check(ChangeUserStatusResponseSchema, data)) throw new InvalidApiResponse(); return data;
  }, async changeUnitMembership(userId:string,unitId:string,input:ChangeUnitMembershipRequest,
    idempotencyKey:string):Promise<ChangeUnitMembershipResponse>{
    const token=await options.getAccessToken();if(!token)throw new AuthenticationRequired();
    const{data,error,response}=await client.POST("/v1/users/{userId}/memberships/{unitId}/lifecycle",{params:{
      path:{userId,unitId},header:{"idempotency-key":idempotencyKey}},body:input,
      headers:{authorization:`Bearer ${token}`,accept:"application/json"}});
    if(!response.ok)mapFailure(error,response);
    if(!Value.Check(ChangeUnitMembershipResponseSchema,data))throw new InvalidApiResponse();return data;
  },async listUnitMemberships(input:{unitId:string;limit?:number;cursor?:string}):Promise<UnitMembershipsPage>{
    const token=await options.getAccessToken();if(!token)throw new AuthenticationRequired();
    const{unitId,...query}=input;const{data,error,response}=await client.GET("/v1/units/{unitId}/memberships",{params:{path:{unitId},query},
      headers:{authorization:`Bearer ${token}`,accept:"application/json"}});
    if(!response.ok)mapFailure(error,response);
    if(!Value.Check(UnitMembershipsPageSchema,data))throw new InvalidApiResponse();return data;
  }, async revokeUserInvitation(invitationId: string, input: RevokeInvitationRequest,
    idempotencyKey: string): Promise<RevokeInvitationResponse> {
    const token = await options.getAccessToken(); if (!token) throw new AuthenticationRequired();
    const { data, error, response } = await client.POST("/v1/users/invitations/{invitationId}/revoke", { params: {
      path: { invitationId }, header: { "idempotency-key": idempotencyKey } }, body: input,
      headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    if (!response.ok) mapFailure(error, response);
    if (!Value.Check(RevokeInvitationResponseSchema, data)) throw new InvalidApiResponse(); return data;
  }, async reissueUserInvitation(invitationId: string, input: ReissueInvitationRequest,
    idempotencyKey: string): Promise<ReissueInvitationResponse> {
    const token = await options.getAccessToken(); if (!token) throw new AuthenticationRequired();
    const { data, error, response } = await client.POST("/v1/users/invitations/{invitationId}/reissue", { params: {
      path: { invitationId }, header: { "idempotency-key": idempotencyKey } }, body: input,
      headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    if (!response.ok) mapFailure(error, response);
    if (!Value.Check(ReissueInvitationResponseSchema, data)) throw new InvalidApiResponse(); return data;
  },async listRoutingRequired(input:{limit?:number;cursor?:string}={}):Promise<ListRoutingRequiredResponse>{
    const token=await options.getAccessToken();if(!token)throw new AuthenticationRequired();
    const{data,error,response}=await client.GET("/v1/inbox/routing-required",{params:{query:input},
      headers:{authorization:`Bearer ${token}`,accept:"application/json"}});
    if(!response.ok)mapFailure(error,response);if(!Value.Check(ListRoutingRequiredResponseSchema,data))throw new InvalidApiResponse();return data;
  },async resolveRoutingRequired(receiptId:string,unitId:string,idempotencyKey:string):Promise<ResolveRoutingRequiredResponse>{
    const token=await options.getAccessToken();if(!token)throw new AuthenticationRequired();
    const{data,error,response}=await client.POST("/v1/inbox/routing-required/{receiptId}/resolve",{params:{path:{receiptId},
      header:{"idempotency-key":idempotencyKey}},body:{unitId},headers:{authorization:`Bearer ${token}`,accept:"application/json"}});
    if(!response.ok)mapFailure(error,response);if(!Value.Check(ResolveRoutingRequiredResponseSchema,data))throw new InvalidApiResponse();return data;
  },async listInboxSlaAlerts(input:{unitId:string;limit?:number;severity?:"MISSING_SLA"|"DUE_SOON"|"OVERDUE";priority?:"LOW"|"NORMAL"|"HIGH"|"URGENT";cursor?:string}):Promise<ListInboxSlaAlertsResponse>{const token=await options.getAccessToken();if(!token)throw new AuthenticationRequired();const{data,error,response}=await client.GET("/v1/inbox/sla-alerts",{params:{query:input},headers:{authorization:`Bearer ${token}`,accept:"application/json"}});if(!response.ok)mapFailure(error,response);if(!Value.Check(ListInboxSlaAlertsResponseSchema,data))throw new InvalidApiResponse();return data;
  },async acknowledgeInboxSlaAlert(handoffId:string,expectedVersion:number,idempotencyKey:string):Promise<AcknowledgeInboxSlaAlertResponse>{const token=await options.getAccessToken();if(!token)throw new AuthenticationRequired();const{data,error,response}=await client.POST("/v1/inbox/sla-alerts/{handoffId}/acknowledge",{params:{path:{handoffId},header:{"idempotency-key":idempotencyKey}},body:{expectedVersion},headers:{authorization:`Bearer ${token}`,accept:"application/json"}});if(!response.ok)mapFailure(error,response);if(!Value.Check(AcknowledgeInboxSlaAlertResponseSchema,data))throw new InvalidApiResponse();return data;
  },async getInboxAvailability(unitId:string):Promise<InboxAvailability>{const token=await options.getAccessToken();if(!token)throw new AuthenticationRequired();
    const{data,error,response}=await client.GET("/v1/inbox/availability",{params:{query:{unitId}},headers:{authorization:`Bearer ${token}`,accept:"application/json"}});
    if(!response.ok)mapFailure(error,response);if(!Value.Check(InboxAvailabilitySchema,data))throw new InvalidApiResponse();return data;
  },async setInboxAvailability(input:SetInboxAvailabilityRequest,idempotencyKey:string):Promise<SetInboxAvailabilityResponse>{const token=await options.getAccessToken();if(!token)throw new AuthenticationRequired();
    const{data,error,response}=await client.POST("/v1/inbox/availability",{params:{header:{"idempotency-key":idempotencyKey}},body:input,headers:{authorization:`Bearer ${token}`,accept:"application/json"}});
    if(!response.ok)mapFailure(error,response);if(!Value.Check(SetInboxAvailabilityResponseSchema,data))throw new InvalidApiResponse();return data;
  },async listHandoffs(input:{unitId:string;limit?:number;cursor?:string;priority?:"LOW"|"NORMAL"|"HIGH"|"URGENT";slaStatus?:"ON_TRACK"|"DUE_SOON"|"OVERDUE"}):Promise<ListHandoffsResponse>{const token=await options.getAccessToken();if(!token)throw new AuthenticationRequired();
    const{data,error,response}=await client.GET("/v1/inbox/handoffs",{params:{query:input},headers:{authorization:`Bearer ${token}`,accept:"application/json"}});
    if(!response.ok)mapFailure(error,response);if(!Value.Check(ListHandoffsResponseSchema,data))throw new InvalidApiResponse();return data;
  },async listResolvedInboxHandoffs(input:{unitId:string;limit?:number;cursor?:string;priority?:"LOW"|"NORMAL"|"HIGH"|"URGENT";disposition?:"LEGACY_UNSPECIFIED"|"RESOLVED"|"DUPLICATE"|"CUSTOMER_WITHDREW"|"EXTERNAL_REFERRAL";resolvedFrom?:string;resolvedBefore?:string}):Promise<ListResolvedHandoffsResponse>{const token=await options.getAccessToken();if(!token)throw new AuthenticationRequired();
    const{data,error,response}=await client.GET("/v1/inbox/resolved",{params:{query:input},headers:{authorization:`Bearer ${token}`,accept:"application/json"}});
    if(!response.ok)mapFailure(error,response);if(!Value.Check(ListResolvedHandoffsResponseSchema,data))throw new InvalidApiResponse();return data;
  },async claimHandoff(handoffId:string,expectedVersion:number,idempotencyKey:string):Promise<ClaimHandoffResponse>{const token=await options.getAccessToken();if(!token)throw new AuthenticationRequired();
    const{data,error,response}=await client.POST("/v1/inbox/handoffs/{handoffId}/claim",{params:{path:{handoffId},header:{"idempotency-key":idempotencyKey}},body:{expectedVersion},
      headers:{authorization:`Bearer ${token}`,accept:"application/json"}});if(!response.ok)mapFailure(error,response);
    if(!Value.Check(ClaimHandoffResponseSchema,data))throw new InvalidApiResponse();return data;
  },async resolveHandoff(handoffId:string,expectedVersion:number,disposition:"RESOLVED"|"DUPLICATE"|"CUSTOMER_WITHDREW"|"EXTERNAL_REFERRAL",idempotencyKey:string):Promise<ResolveHandoffResponse>{const token=await options.getAccessToken();if(!token)throw new AuthenticationRequired();
    const{data,error,response}=await client.POST("/v1/inbox/handoffs/{handoffId}/resolve",{params:{path:{handoffId},header:{"idempotency-key":idempotencyKey}},body:{expectedVersion,disposition},
      headers:{authorization:`Bearer ${token}`,accept:"application/json"}});if(!response.ok)mapFailure(error,response);
    if(!Value.Check(ResolveHandoffResponseSchema,data))throw new InvalidApiResponse();return data;
  },async requeueHandoff(handoffId:string,expectedVersion:number,idempotencyKey:string):Promise<RequeueHandoffResponse>{const token=await options.getAccessToken();if(!token)throw new AuthenticationRequired();
    const{data,error,response}=await client.POST("/v1/inbox/handoffs/{handoffId}/requeue",{params:{path:{handoffId},header:{"idempotency-key":idempotencyKey}},body:{expectedVersion},
      headers:{authorization:`Bearer ${token}`,accept:"application/json"}});if(!response.ok)mapFailure(error,response);
    if(!Value.Check(RequeueHandoffResponseSchema,data))throw new InvalidApiResponse();return data;
  },async reopenInboxHandoff(handoffId:string,expectedVersion:number,reason:"FOLLOW_UP_REQUIRED"|"PREMATURE_CLOSURE"|"NEW_INFORMATION"|"OPERATIONAL_CORRECTION",idempotencyKey:string):Promise<ReopenHandoffResponse>{const token=await options.getAccessToken();if(!token)throw new AuthenticationRequired();
    const{data,error,response}=await client.POST("/v1/inbox/handoffs/{handoffId}/reopen",{params:{path:{handoffId},header:{"idempotency-key":idempotencyKey}},body:{expectedVersion,reason},
      headers:{authorization:`Bearer ${token}`,accept:"application/json"}});if(!response.ok)mapFailure(error,response);
    if(!Value.Check(ReopenHandoffResponseSchema,data))throw new InvalidApiResponse();return data;
  },async listInboxHandoffTransferCandidates(handoffId:string):Promise<ListInboxTransferCandidatesResponse>{const token=await options.getAccessToken();if(!token)throw new AuthenticationRequired();
    const{data,error,response}=await client.GET("/v1/inbox/handoffs/{handoffId}/transfer-candidates",{params:{path:{handoffId}},headers:{authorization:`Bearer ${token}`,accept:"application/json"}});
    if(!response.ok)mapFailure(error,response);if(!Value.Check(ListInboxTransferCandidatesResponseSchema,data))throw new InvalidApiResponse();return data;
  },async transferInboxHandoff(handoffId:string,expectedVersion:number,targetUserId:string,reason:"SHIFT_CHANGE"|"LOAD_BALANCING"|"SPECIALIZED_SUPPORT"|"OPERATIONAL_CONTINUITY",idempotencyKey:string):Promise<TransferHandoffResponse>{const token=await options.getAccessToken();if(!token)throw new AuthenticationRequired();
    const{data,error,response}=await client.POST("/v1/inbox/handoffs/{handoffId}/transfer",{params:{path:{handoffId},header:{"idempotency-key":idempotencyKey}},body:{expectedVersion,targetUserId,reason},
      headers:{authorization:`Bearer ${token}`,accept:"application/json"}});if(!response.ok)mapFailure(error,response);
    if(!Value.Check(TransferHandoffResponseSchema,data))throw new InvalidApiResponse();return data;
  },async takeoverInboxHandoff(handoffId:string,expectedVersion:number,idempotencyKey:string):Promise<TakeoverHandoffResponse>{const token=await options.getAccessToken();if(!token)throw new AuthenticationRequired();
    const{data,error,response}=await client.POST("/v1/inbox/handoffs/{handoffId}/takeover",{params:{path:{handoffId},header:{"idempotency-key":idempotencyKey}},body:{expectedVersion},
      headers:{authorization:`Bearer ${token}`,accept:"application/json"}});if(!response.ok)mapFailure(error,response);
    if(!Value.Check(TakeoverHandoffResponseSchema,data))throw new InvalidApiResponse();return data;
  },async listActiveInboxHandoffs(input:{unitId:string;limit?:number;cursor?:string}):Promise<ListHandoffsResponse>{const token=await options.getAccessToken();if(!token)throw new AuthenticationRequired();
    const{data,error,response}=await client.GET("/v1/inbox/active",{params:{query:input},headers:{authorization:`Bearer ${token}`,accept:"application/json"}});
    if(!response.ok)mapFailure(error,response);if(!Value.Check(ListHandoffsResponseSchema,data))throw new InvalidApiResponse();return data;
  },async listSupervisedInboxHandoffs(input:{unitId:string;limit?:number;cursor?:string}):Promise<ListHandoffsResponse>{const token=await options.getAccessToken();if(!token)throw new AuthenticationRequired();
    const{data,error,response}=await client.GET("/v1/inbox/supervised",{params:{query:input},headers:{authorization:`Bearer ${token}`,accept:"application/json"}});
    if(!response.ok)mapFailure(error,response);if(!Value.Check(ListHandoffsResponseSchema,data))throw new InvalidApiResponse();return data;
  },async getInboxConversation(conversationId:string):Promise<InboxConversation>{const token=await options.getAccessToken();if(!token)throw new AuthenticationRequired();
    const{data,error,response}=await client.GET("/v1/inbox/conversations/{conversationId}",{params:{path:{conversationId}},headers:{authorization:`Bearer ${token}`,accept:"application/json"}});
    if(!response.ok)mapFailure(error,response);if(!Value.Check(InboxConversationSchema,data))throw new InvalidApiResponse();return data;
  },async listInboxConversationMessages(conversationId:string,input:{limit?:number;cursor?:string;before?:string}={}):Promise<ListInboxMessagesResponse>{const token=await options.getAccessToken();if(!token)throw new AuthenticationRequired();
    const{data,error,response}=await client.GET("/v1/inbox/conversations/{conversationId}/messages",{params:{path:{conversationId},query:input},headers:{authorization:`Bearer ${token}`,accept:"application/json"}});
    if(!response.ok)mapFailure(error,response);if(!Value.Check(ListInboxMessagesResponseSchema,data))throw new InvalidApiResponse();return data;
  },async sendHumanTextMessage(conversationId:string,input:{body:string;expectedConversationVersion:number},idempotencyKey:string):Promise<SendHumanTextMessageResponse>{const token=await options.getAccessToken();if(!token)throw new AuthenticationRequired();
    const{data,error,response}=await client.POST("/v1/inbox/conversations/{conversationId}/messages",{params:{path:{conversationId},header:{"idempotency-key":idempotencyKey}},
      body:{kind:"TEXT",body:input.body,expectedConversationVersion:input.expectedConversationVersion},headers:{authorization:`Bearer ${token}`,accept:"application/json"}});
    if(!response.ok)mapFailure(error,response);if(!Value.Check(SendHumanTextMessageResponseSchema,data))throw new InvalidApiResponse();return data;
  },async cancelHumanTextMessage(conversationId:string,messageId:string,expectedConversationVersion:number,idempotencyKey:string):Promise<CancelHumanTextMessageResponse>{const token=await options.getAccessToken();if(!token)throw new AuthenticationRequired();
    const{data,error,response}=await client.POST("/v1/inbox/conversations/{conversationId}/messages/{messageId}/cancel",{params:{path:{conversationId,messageId},header:{"idempotency-key":idempotencyKey}},
      body:{expectedConversationVersion},headers:{authorization:`Bearer ${token}`,accept:"application/json"}});if(!response.ok)mapFailure(error,response);
    if(!Value.Check(CancelHumanTextMessageResponseSchema,data))throw new InvalidApiResponse();return data;
  }, async acceptUserInvitation(invitationToken: string, idempotencyKey: string): Promise<AcceptUserInvitationResponse> {
    const token = await options.getAccessToken(); if (!token) throw new AuthenticationRequired();
    const { data, error, response } = await client.POST("/v1/auth/invitations/accept", { params: {
      header: { "idempotency-key": idempotencyKey } }, body: { invitationToken },
      headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    if (!response.ok) mapFailure(error, response);
    if (!Value.Check(AcceptUserInvitationResponseSchema, data)) throw new InvalidApiResponse(); return data;
  } };
}
