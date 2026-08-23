import type { FastifyInstance } from "fastify";
import { ChannelConnectionMetadataRequestSchema, ChannelConnectionMetadataResponseSchema, ChannelConnectionsPageSchema, ProblemDetailsSchema, type ChannelConnectionMetadataRequest } from "@zap-pronto/contracts";
import type { TenantTransactionPool } from "@zap-pronto/core/database/tenant-transaction";
import { listChannelConnections, setChannelConnectionMetadata } from "@zap-pronto/core/domain/channel-connections";
import { protectedRoute } from "../http/protected-route.js";

const problems = { 400: ProblemDetailsSchema, 401: ProblemDetailsSchema, 403: ProblemDetailsSchema, 409: ProblemDetailsSchema, 500: ProblemDetailsSchema, 503: ProblemDetailsSchema } as const;
function idempotencyKey(headers: Record<string, unknown>): string {
  const value=headers["idempotency-key"];
  if(typeof value!=="string"||value.trim()!==value||value.length<8||value.length>200) throw new ChannelConnectionError(400,"INVALID_REQUEST");
  return value;
}
export class ChannelConnectionError extends Error {
  constructor(readonly statusCode:400|404|409,readonly code:string){super(code)}
  static from(error:unknown):never {
    if(error instanceof ChannelConnectionError) throw error;
    const code=error instanceof Error?error.message:"";
    if(code==="INVALID_CHANNEL_CONNECTION_REQUEST") throw new ChannelConnectionError(400,"INVALID_REQUEST");
    if(code==="CHANNEL_CONNECTION_NOT_FOUND") throw new ChannelConnectionError(404,"RESOURCE_NOT_FOUND");
    if(code==="CHANNEL_CONNECTION_CONFLICT"||code==="CHANNEL_CONNECTION_IDEMPOTENCY_CONFLICT") throw new ChannelConnectionError(409,"CHANNEL_CONNECTION_CONFLICT");
    throw error;
  }
}
export function registerChannelConnectionRoutes(app: FastifyInstance, pool: TenantTransactionPool): void {
  app.get("/v1/channel-connections", protectedRoute({
    pool, noStore: true,
    authorization: { kind: "permission", permission: "channel_connections.read", scope: { kind: "tenant" } },
    schema: { operationId: "listChannelConnections", response: { 200: ChannelConnectionsPageSchema, ...problems } },
    async handler(client) { return { items: await listChannelConnections(client) }; },
  }));
  app.post("/v1/channel-connections", protectedRoute({
    pool, noStore: true,
    authorization: { kind: "permission", permission: "channel_connections.manage", scope: { kind: "tenant" } },
    schema: { operationId: "setChannelConnectionMetadata", headers: { type: "object", required: ["idempotency-key"], properties: { "idempotency-key": { type: "string", minLength: 8, maxLength: 200 } } }, body: ChannelConnectionMetadataRequestSchema, response: { 200: ChannelConnectionMetadataResponseSchema, ...problems } },
    async handler(client, request, reply) {
      void reply.header("cache-control", "no-store");
      try {
        const body=request.body as ChannelConnectionMetadataRequest;
        const result=await setChannelConnectionMetadata(client,{...body,idempotencyKey:idempotencyKey(request.headers)});
        const { replayed, ...connection }=result;
        return { connection, replayed };
      } catch(error) { return ChannelConnectionError.from(error); }
    },
  }));
}
