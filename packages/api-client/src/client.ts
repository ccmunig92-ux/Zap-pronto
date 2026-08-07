import createClient from "openapi-fetch";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { AcceptUserInvitationResponseSchema, AdministrativeInvitationsPageSchema, AdministrativeUsersPageSchema, ChangeUserStatusResponseSchema,
  CreateUserInvitationResponseSchema, CurrentUserSchema, ProblemDetailsSchema, ReissueInvitationResponseSchema,
  RevokeInvitationResponseSchema,
  UserInvitationOptionsSchema, type CreateUserInvitationRequest, type CreateUserInvitationResponse,
  type AcceptUserInvitationResponse, type AdministrativeInvitationsPage, type AdministrativeUsersPage, type ChangeUserStatusRequest,
  type ChangeUserStatusResponse, type CurrentUser, type ProblemDetails, type ReissueInvitationRequest,
  type ReissueInvitationResponse, type RevokeInvitationRequest, type RevokeInvitationResponse,
  type UserInvitationOptions } from "@zap-pronto/contracts";
import type { paths } from "./generated.js";

if (!FormatRegistry.Has("uuid")) FormatRegistry.Set("uuid", (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
if (!FormatRegistry.Has("date-time")) FormatRegistry.Set("date-time", (value) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value)));

export class ApiProblem extends Error {
  constructor(readonly problem: ProblemDetails) { super(problem.title); this.name = "ApiProblem"; }
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
function mapFailure(error: unknown): never {
  if (Value.Check(ProblemDetailsSchema, error)) {
    if (error.status === 401) throw new AuthenticationRequired();
    throw new ApiProblem(error);
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
      mapFailure(error);
    }
    if (!Value.Check(CurrentUserSchema, data)) throw new InvalidApiResponse();
    return data;
  }, async getUserInvitationOptions(): Promise<UserInvitationOptions> {
    const token = await options.getAccessToken();
    if (!token) throw new AuthenticationRequired();
    const { data, error, response } = await client.GET("/v1/users/invitations/options", {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!response.ok) mapFailure(error);
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
    if (!response.ok) mapFailure(error);
    if (!Value.Check(CreateUserInvitationResponseSchema, data)) throw new InvalidApiResponse();
    return data;
  }, async listAdministrativeUsers(input: { limit?: number; cursor?: string } = {}): Promise<AdministrativeUsersPage> {
    const token = await options.getAccessToken(); if (!token) throw new AuthenticationRequired();
    const { data, error, response } = await client.GET("/v1/users", { params: { query: input },
      headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    if (!response.ok) mapFailure(error);
    if (!Value.Check(AdministrativeUsersPageSchema, data)) throw new InvalidApiResponse(); return data;
  }, async listAdministrativeInvitations(input: { limit?: number; cursor?: string } = {}): Promise<AdministrativeInvitationsPage> {
    const token = await options.getAccessToken(); if (!token) throw new AuthenticationRequired();
    const { data, error, response } = await client.GET("/v1/users/invitations", { params: { query: input },
      headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    if (!response.ok) mapFailure(error);
    if (!Value.Check(AdministrativeInvitationsPageSchema, data)) throw new InvalidApiResponse(); return data;
  }, async changeAdministrativeUserStatus(userId: string, input: ChangeUserStatusRequest,
    idempotencyKey: string): Promise<ChangeUserStatusResponse> {
    const token = await options.getAccessToken(); if (!token) throw new AuthenticationRequired();
    const { data, error, response } = await client.POST("/v1/users/{userId}/status", { params: {
      path: { userId }, header: { "idempotency-key": idempotencyKey } }, body: input,
      headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    if (!response.ok) mapFailure(error);
    if (!Value.Check(ChangeUserStatusResponseSchema, data)) throw new InvalidApiResponse(); return data;
  }, async revokeUserInvitation(invitationId: string, input: RevokeInvitationRequest,
    idempotencyKey: string): Promise<RevokeInvitationResponse> {
    const token = await options.getAccessToken(); if (!token) throw new AuthenticationRequired();
    const { data, error, response } = await client.POST("/v1/users/invitations/{invitationId}/revoke", { params: {
      path: { invitationId }, header: { "idempotency-key": idempotencyKey } }, body: input,
      headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    if (!response.ok) mapFailure(error);
    if (!Value.Check(RevokeInvitationResponseSchema, data)) throw new InvalidApiResponse(); return data;
  }, async reissueUserInvitation(invitationId: string, input: ReissueInvitationRequest,
    idempotencyKey: string): Promise<ReissueInvitationResponse> {
    const token = await options.getAccessToken(); if (!token) throw new AuthenticationRequired();
    const { data, error, response } = await client.POST("/v1/users/invitations/{invitationId}/reissue", { params: {
      path: { invitationId }, header: { "idempotency-key": idempotencyKey } }, body: input,
      headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    if (!response.ok) mapFailure(error);
    if (!Value.Check(ReissueInvitationResponseSchema, data)) throw new InvalidApiResponse(); return data;
  }, async acceptUserInvitation(invitationToken: string, idempotencyKey: string): Promise<AcceptUserInvitationResponse> {
    const token = await options.getAccessToken(); if (!token) throw new AuthenticationRequired();
    const { data, error, response } = await client.POST("/v1/auth/invitations/accept", { params: {
      header: { "idempotency-key": idempotencyKey } }, body: { invitationToken },
      headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    if (!response.ok) mapFailure(error);
    if (!Value.Check(AcceptUserInvitationResponseSchema, data)) throw new InvalidApiResponse(); return data;
  } };
}
