import type { FastifyInstance } from "fastify";
import { CurrentUserSchema, ProblemDetailsSchema } from "@zap-pronto/contracts";
import { getCurrentUser } from "@zap-pronto/core/database/current-user";
import type { TenantTransactionPool } from "@zap-pronto/core/database/tenant-transaction";
import { protectedRoute } from "../http/protected-route.js";

export function registerCurrentUserRoute(app: FastifyInstance, pool: TenantTransactionPool): void {
  app.get("/v1/me", protectedRoute({
    pool,
    authorization: { kind: "bootstrap" },
    schema: {
      operationId: "getCurrentUser",
      response: { 200: CurrentUserSchema, 401: ProblemDetailsSchema, 403: ProblemDetailsSchema,
        500: ProblemDetailsSchema, 503: ProblemDetailsSchema },
    },
    async handler(client, _request, reply) {
      void reply.header("cache-control", "no-store");
      return getCurrentUser(client);
    },
  }));
}
