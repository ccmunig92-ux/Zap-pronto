import type { FastifyInstance } from "fastify";
import { ChannelConnectionsPageSchema, ProblemDetailsSchema } from "@zap-pronto/contracts";
import type { TenantTransactionPool } from "@zap-pronto/core/database/tenant-transaction";
import { listChannelConnections } from "@zap-pronto/core/domain/channel-connections";
import { protectedRoute } from "../http/protected-route.js";

const problems = { 400: ProblemDetailsSchema, 401: ProblemDetailsSchema, 403: ProblemDetailsSchema, 409: ProblemDetailsSchema, 500: ProblemDetailsSchema, 503: ProblemDetailsSchema } as const;
export function registerChannelConnectionRoutes(app: FastifyInstance, pool: TenantTransactionPool): void {
  app.get("/v1/channel-connections", protectedRoute({
    pool, noStore: true,
    authorization: { kind: "permission", permission: "channel_connections.read", scope: { kind: "tenant" } },
    schema: { operationId: "listChannelConnections", response: { 200: ChannelConnectionsPageSchema, ...problems } },
    async handler(client) { return { items: await listChannelConnections(client) }; },
  }));
}
