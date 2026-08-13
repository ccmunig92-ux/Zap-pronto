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
import { registerUserInvitationAcceptanceRoute } from "./routes/user-invitation-acceptance.js";
import { registerInboxHandoffRoutes } from "./routes/inbox-handoffs.js";
import { registerInboxRoutingRequiredRoutes } from "./routes/inbox-routing-required.js";
import { registerInboxConversationRoutes } from "./routes/inbox-conversations.js";
import { registerInboxAvailabilityRoutes } from "./routes/inbox-availability.js";
import { registerInboxSlaAlertRoutes } from "./routes/inbox-sla-alerts.js";
import { registerUnitSlaPolicyRoutes } from "./routes/unit-sla-policy.js";
import { registerMetaWebhookRoutes, type MetaWebhookOptions } from "./routes/meta-webhook.js";

const safeCorrelationId = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export interface BuildAppOptions {
  readonly identityVerifier?: IdentityVerifier;
  readonly pool?: TenantTransactionPool;
  readonly metaWebhook?: MetaWebhookOptions;
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
  app.get("/health/ready", {
    config: { public: true },
    schema: {
      operationId: "getHealthReady", security: [],
      response: {
        200: HealthSchema,
        503: { content: { "application/problem+json": { schema: ProblemDetailsSchema } } },
      },
    },
  }, async (request, reply) => {
    let connection: Awaited<ReturnType<TenantTransactionPool["connect"]>> | undefined;
    try {
      connection = await (options.pool ?? unavailablePool).connect();
      await connection.query("SELECT 1");
      return { status: "ok" as const };
    } catch {
      return reply.status(503).type("application/problem+json").send({
        type: "urn:zap-pronto:error:service-unavailable",
        title: "Service Unavailable",
        status: 503,
        detail: "The service is not ready",
        correlationId: request.id,
      });
    } finally {
      connection?.release();
    }
  });
  registerCurrentUserRoute(app, options.pool ?? unavailablePool);
  registerUserInvitationRoutes(app, options.pool ?? unavailablePool);
  registerUserAdministrationRoutes(app, options.pool ?? unavailablePool);
  registerUserInvitationAcceptanceRoute(app, options.pool ?? unavailablePool);
  registerInboxHandoffRoutes(app, options.pool ?? unavailablePool);
  registerInboxRoutingRequiredRoutes(app, options.pool ?? unavailablePool);
  registerInboxConversationRoutes(app, options.pool ?? unavailablePool);
  registerInboxAvailabilityRoutes(app, options.pool ?? unavailablePool);
  registerInboxSlaAlertRoutes(app, options.pool ?? unavailablePool);
  registerUnitSlaPolicyRoutes(app, options.pool ?? unavailablePool);
  await registerMetaWebhookRoutes(app, options.pool ?? unavailablePool, options.metaWebhook ?? { enabled: false });
  return app;
}
