import type { FastifyInstance } from "fastify";
import { CreateUserInvitationRequestSchema, CreateUserInvitationResponseSchema, ProblemDetailsSchema,
  UserInvitationOptionsSchema,
  type CreateUserInvitationRequest } from "@zap-pronto/contracts";
import { createUserInvitation, getUserInvitationOptions } from "@zap-pronto/core/domain/user-invitations";
import type { TenantTransactionPool } from "@zap-pronto/core/database/tenant-transaction";
import { protectedRoute } from "../http/protected-route.js";
import { InvitationRequestError } from "./user-invitations-errors.js";

const headersSchema = {
  type: "object", required: ["idempotency-key"],
  properties: { "idempotency-key": { type: "string", minLength: 8, maxLength: 200 } },
} as const;

export function registerUserInvitationRoutes(app: FastifyInstance, pool: TenantTransactionPool): void {
  app.get("/v1/users/invitations/options", protectedRoute({
    pool,
    authorization: { kind: "permission", permission: "tenant.users.manage", scope: { kind: "tenant" } },
    schema: { operationId: "getUserInvitationOptions", response: { 200: UserInvitationOptionsSchema,
      401: ProblemDetailsSchema, 403: ProblemDetailsSchema, 500: ProblemDetailsSchema, 503: ProblemDetailsSchema } },
    async handler(client, _request, reply) {
      void reply.header("cache-control", "no-store");
      return getUserInvitationOptions(client);
    },
  }));
  app.post<{ Body: CreateUserInvitationRequest; Headers: { "idempotency-key": string } }>(
    "/v1/users/invitations",
    protectedRoute({
      pool,
      authorization: { kind: "permission", permission: "tenant.users.manage", scope: { kind: "tenant" } },
      schema: { operationId: "createUserInvitation", headers: headersSchema, body: CreateUserInvitationRequestSchema,
        response: { 200: CreateUserInvitationResponseSchema, 201: CreateUserInvitationResponseSchema,
          400: ProblemDetailsSchema, 401: ProblemDetailsSchema, 403: ProblemDetailsSchema,
          404: ProblemDetailsSchema, 409: ProblemDetailsSchema, 500: ProblemDetailsSchema, 503: ProblemDetailsSchema } },
      async handler(client, request, reply) {
        try {
          const body = request.body as CreateUserInvitationRequest;
          const idempotencyHeader = request.headers["idempotency-key"];
          if (typeof idempotencyHeader !== "string") throw new Error("INVALID_IDEMPOTENCY_KEY");
          const result = await createUserInvitation(client, { ...body,
            expiresAt: new Date(body.expiresAt), idempotencyKey: idempotencyHeader });
          void reply.header("cache-control", "no-store");
          if (!result.replayed) void reply.header("location", `/v1/users/invitations/${result.id}`);
          void reply.status(result.replayed ? 200 : 201);
          return { invitation: { id: result.id, email: result.email, displayName: result.displayName,
            status: result.status, expiresAt: result.expiresAt.toISOString(), providerCode: result.providerCode },
          assignments: result.assignments, replayed: result.replayed,
          ...(!result.replayed && result.token ? { invitationToken: result.token } : {}) };
        } catch (error) { throw InvitationRequestError.from(error); }
      },
    }),
  );
}
