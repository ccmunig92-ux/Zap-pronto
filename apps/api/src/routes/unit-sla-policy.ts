import type { FastifyInstance } from "fastify";
import {
  ProblemDetailsSchema,
  SetUnitSlaPolicyRequestSchema,
  SetUnitSlaPolicyResponseSchema,
  UnitSlaPolicyParamsSchema,
  UnitSlaPolicySchema,
  type SetUnitSlaPolicyRequest,
  type UnitSlaPolicy,
} from "@zap-pronto/contracts";
import type { TenantTransactionPool } from "@zap-pronto/core/database/tenant-transaction";
import { getUnitSlaPolicy, setUnitSlaPolicy, type UnitSlaPolicy as DomainUnitSlaPolicy } from "@zap-pronto/core/domain/sla-policy";
import { protectedRoute } from "../http/protected-route.js";

const problems = {
  400: ProblemDetailsSchema,
  401: ProblemDetailsSchema,
  403: ProblemDetailsSchema,
  404: ProblemDetailsSchema,
  409: ProblemDetailsSchema,
  500: ProblemDetailsSchema,
  503: ProblemDetailsSchema,
} as const;
function key(headers: Record<string, unknown>) {
  const value = headers["idempotency-key"];
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 8 ||
    value.length > 200
  )
    throw new SlaPolicyError(400, "INVALID_REQUEST");
  return value;
}
function view(row: DomainUnitSlaPolicy): UnitSlaPolicy {
  return {
    unitId: row.unitId,
    version: row.version,
    effectiveAt: row.effectiveAt.toISOString(),
    targets: row.targets,
  };
}
export class SlaPolicyError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409,
    readonly code: string,
  ) {
    super(code);
  }
  static from(error: unknown): never {
    if (error instanceof SlaPolicyError) throw error;
    const code = error instanceof Error ? error.message : "";
    if (code === "INVALID_SLA_POLICY_REQUEST")
      throw new SlaPolicyError(400, "INVALID_REQUEST");
    if (code === "SLA_POLICY_NOT_FOUND")
      throw new SlaPolicyError(404, "RESOURCE_NOT_FOUND");
    if (
      code === "SLA_POLICY_CONFLICT" ||
      code === "SLA_POLICY_IDEMPOTENCY_CONFLICT"
    )
      throw new SlaPolicyError(409, "SLA_POLICY_CONFLICT");
    throw error;
  }
}
export function registerUnitSlaPolicyRoutes(
  app: FastifyInstance,
  pool: TenantTransactionPool,
): void {
  app.get(
    "/v1/units/:unitId/sla-policy",
    protectedRoute({
      pool,
      noStore: true,
      authorization: {
        kind: "permission",
        permission: "sla_policy.read",
        scope: {
          kind: "unit",
          async resolveUnitId(_client, request) {
            return (request.params as { unitId: string }).unitId;
          },
        },
      },
      schema: {
        operationId: "getUnitSlaPolicy",
        params: UnitSlaPolicyParamsSchema,
        response: { 200: UnitSlaPolicySchema, ...problems },
      },
      async handler(client, request, reply) {
        void reply.header("cache-control", "no-store");
        try {
          return view(await getUnitSlaPolicy(client,(request.params as { unitId: string }).unitId));
        } catch (error) {
          return SlaPolicyError.from(error);
        }
      },
    }),
  );
  app.post(
    "/v1/units/:unitId/sla-policy",
    protectedRoute({
      pool,
      noStore: true,
      authorization: {
        kind: "permission",
        permission: "sla_policy.manage",
        scope: {
          kind: "unit",
          async resolveUnitId(_client, request) {
            return (request.params as { unitId: string }).unitId;
          },
        },
      },
      schema: {
        operationId: "setUnitSlaPolicy",
        params: UnitSlaPolicyParamsSchema,
        headers: {
          type: "object",
          required: ["idempotency-key"],
          properties: {
            "idempotency-key": { type: "string", minLength: 8, maxLength: 200 },
          },
        },
        body: SetUnitSlaPolicyRequestSchema,
        response: { 200: SetUnitSlaPolicyResponseSchema, ...problems },
      },
      async handler(client, request, reply) {
        void reply.header("cache-control", "no-store");
        try {
          const unitId = (request.params as { unitId: string }).unitId,
            body = request.body as SetUnitSlaPolicyRequest,
            idempotencyKey = key(request.headers);
          const row=await setUnitSlaPolicy(client,{unitId,expectedVersion:body.expectedVersion,targets:body.targets,idempotencyKey});
          return { ...view(row), replayed: row.replayed };
        } catch (error) {
          return SlaPolicyError.from(error);
        }
      },
    }),
  );
}
