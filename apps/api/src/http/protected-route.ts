import type { FastifyReply, FastifyRequest, FastifySchema, RouteHandlerMethod } from "fastify";
import { withAuthenticatedTenantTransaction, withVerifiedOidcBootstrapTransaction, type TenantQueryClient,
  type TenantTransactionPool } from "@zap-pronto/core/database/tenant-transaction";
import type { Permission } from "../authorization/permissions.js";
import { AuthorizationDeniedError, requirePermission } from "../authorization/authorize.js";
import { AuthenticationError } from "../auth/errors.js";

const protectedRouteConfigurations = new WeakSet<object>();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isProtectedRouteConfig(config: object): boolean {
  return protectedRouteConfigurations.has(config);
}

type ProtectedScope =
  | { readonly kind: "tenant" }
  | {
    readonly kind: "unit";
    readonly resolveUnitId: (client: TenantQueryClient, request: FastifyRequest) => Promise<string>;
  };

export interface ProtectedRouteInput {
  readonly pool: TenantTransactionPool;
  readonly authorization:
    | { readonly kind: "bootstrap" }
    | { readonly kind: "preProvisioning" }
    | { readonly kind: "permission"; readonly permission: Permission; readonly scope: ProtectedScope };
  readonly schema?: FastifySchema;
  readonly handler: (client: TenantQueryClient, request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

export function protectedRoute(input: ProtectedRouteInput): {
  config: { permission?: Permission; authenticated: true; bootstrap?: true; preProvisioning?: true };
  schema: FastifySchema;
  handler: RouteHandlerMethod;
} {
  const config = input.authorization.kind === "permission"
    ? { permission: input.authorization.permission, authenticated: true as const }
    : input.authorization.kind === "bootstrap"
      ? { authenticated: true as const, bootstrap: true as const }
      : { authenticated: true as const, preProvisioning: true as const };
  protectedRouteConfigurations.add(config);
  return {
    config,
    ...(input.schema ? { schema: { ...input.schema, security: [{ bearerAuth: [] }] } }
      : { schema: { security: [{ bearerAuth: [] }] } }),
    handler: async (request, reply) => {
      const authorization = input.authorization;
      const identity = request.externalIdentity;
      if (!identity) throw AuthenticationError.rejected();
      const principal = {
        issuer: identity.issuer, audience: identity.audience, subject: identity.subject,
        ...(identity.organization ? { organizationClaim: identity.organization.claim,
          organizationValue: identity.organization.value } : {}), correlationId: request.id,
      };
      try {
        if (authorization.kind === "preProvisioning") {
          return await withVerifiedOidcBootstrapTransaction(input.pool, principal,
            (client) => input.handler(client, request, reply));
        }
        return await withAuthenticatedTenantTransaction(input.pool, principal, async (client) => {
          if (authorization.kind === "bootstrap") return input.handler(client, request, reply);
          const unitId = authorization.scope.kind === "unit"
            ? await authorization.scope.resolveUnitId(client, request)
            : undefined;
          if (authorization.scope.kind === "unit" && !uuidPattern.test(unitId ?? "")) {
            throw new AuthorizationDeniedError();
          }
          await requirePermission(client, authorization.permission, unitId);
          return input.handler(client, request, reply);
        });
      } catch (error) {
        if (error instanceof Error && error.message === "AUTH_UNAUTHORIZED") {
          throw AuthenticationError.rejected();
        }
        throw error;
      }
    },
  };
}
