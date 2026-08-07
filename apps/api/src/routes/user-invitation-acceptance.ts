import type { FastifyInstance } from "fastify";
import { AcceptUserInvitationRequestSchema, AcceptUserInvitationResponseSchema, ProblemDetailsSchema,
  type AcceptUserInvitationRequest } from "@zap-pronto/contracts";
import { acceptUserInvitation } from "@zap-pronto/core/domain/user-invitation-acceptance";
import type { TenantTransactionPool } from "@zap-pronto/core/database/tenant-transaction";
import { protectedRoute } from "../http/protected-route.js";
import { AuthenticationError } from "../auth/errors.js";
import { InvitationRequestError } from "./user-invitations-errors.js";
import { consumeInvitationAcceptanceRateLimit } from "@zap-pronto/core/domain/invitation-acceptance-rate-limit";
import { RateLimitExceededError } from "../http/rate-limit.js";

const headersSchema = { type: "object", required: ["idempotency-key"], properties: {
  "idempotency-key": { type: "string", minLength: 8, maxLength: 200 },
} } as const;

export function registerUserInvitationAcceptanceRoute(app: FastifyInstance, pool: TenantTransactionPool): void {
  app.post("/v1/auth/invitations/accept", protectedRoute({
    pool, authorization: { kind: "preProvisioning" },
    async beforeTransaction(principal) {
      const limit = await consumeInvitationAcceptanceRateLimit(pool, principal);
      if (!limit.allowed) throw new RateLimitExceededError(limit.retryAfterSeconds);
    },
    schema: { operationId: "acceptUserInvitation", headers: headersSchema, body: AcceptUserInvitationRequestSchema,
      response: { 200: AcceptUserInvitationResponseSchema, 400: ProblemDetailsSchema, 401: ProblemDetailsSchema,
        403: ProblemDetailsSchema, 409: ProblemDetailsSchema, 429: ProblemDetailsSchema,
        500: ProblemDetailsSchema, 503: ProblemDetailsSchema } },
    async handler(client, request, reply) {
      const identity = request.externalIdentity;
      if (!identity) throw AuthenticationError.rejected();
      const idempotencyHeader = request.headers["idempotency-key"];
      if (typeof idempotencyHeader !== "string") throw new InvitationRequestError("INVALID_IDEMPOTENCY_KEY", 400);
      try {
        const body = request.body as AcceptUserInvitationRequest;
        const result = await acceptUserInvitation(client, { invitationToken: body.invitationToken,
          idempotencyKey: idempotencyHeader, principal: { issuer: identity.issuer, audience: identity.audience,
            subject: identity.subject, correlationId: request.id,
            ...(identity.verifiedEmail ? { verifiedEmail: identity.verifiedEmail } : {}),
            ...(identity.organization ? { organizationClaim: identity.organization.claim,
              organizationValue: identity.organization.value } : {}) } });
        void reply.header("cache-control", "no-store");
        return result;
      } catch (error) { throw InvitationRequestError.from(error); }
    },
  }));
}
