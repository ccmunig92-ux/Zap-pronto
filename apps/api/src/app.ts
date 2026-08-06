import Fastify from "fastify";
import swagger from "@fastify/swagger";
import { HealthSchema, ProblemDetailsSchema } from "@zap-pronto/contracts";
import { randomUUID } from "node:crypto";
import type { IdentityVerifier } from "./auth/contracts.js";
import { registerAuthenticationBoundary } from "./auth/plugin.js";
import { registerProblemDetailsHandler } from "./http/problem-details.js";
import type { TenantTransactionPool } from "@zap-pronto/core/database/tenant-transaction";
import { registerCurrentUserRoute } from "./routes/current-user.js";
import { registerUserInvitationRoutes } from "./routes/user-invitations.js";
import { registerUserAdministrationRoutes } from "./routes/user-administration.js";

const safeCorrelationId = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export interface BuildAppOptions {
  readonly identityVerifier?: IdentityVerifier;
  readonly pool?: TenantTransactionPool;
}

const unavailablePool: TenantTransactionPool = {
  async connect() { throw new Error("DATABASE_POOL_UNAVAILABLE"); },
};

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: false,
    requestIdHeader: false,
    genReqId(request) {
      const candidate = request.headers["x-correlation-id"];
      return typeof candidate === "string" && safeCorrelationId.test(candidate) ? candidate : randomUUID();
    },
  });
  await app.register(swagger, {
    openapi: {
      info: { title: "Zap Pronto API", version: "0.1.0" },
      components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
    },
  });
  app.addSchema(HealthSchema);
  app.addSchema(ProblemDetailsSchema);
  registerProblemDetailsHandler(app);
  registerAuthenticationBoundary(app, { verifier: options.identityVerifier });
  app.addHook("onSend", async (request, reply) => {
    void reply.header("x-correlation-id", request.id);
  });
  app.get("/health/live", {
    config: { public: true },
    schema: { operationId: "getHealthLive", security: [], response: { 200: HealthSchema } },
  }, async () => ({ status: "ok" as const }));
  registerCurrentUserRoute(app, options.pool ?? unavailablePool);
  registerUserInvitationRoutes(app, options.pool ?? unavailablePool);
  registerUserAdministrationRoutes(app, options.pool ?? unavailablePool);
  return app;
}
