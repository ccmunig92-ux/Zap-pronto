import Fastify, { LogController } from "fastify";
import type { FastifyServerOptions } from "fastify";
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
import { registerInboxTeamAvailabilityRoute } from "./routes/inbox-team-availability.js";
import { registerInboxSlaAlertRoutes } from "./routes/inbox-sla-alerts.js";
import { registerUnitSlaPolicyRoutes } from "./routes/unit-sla-policy.js";
import { registerUnitCapacityAlertRoutes } from "./routes/unit-capacity-alert.js";
import { registerUnitOperationalTimezoneRoutes } from "./routes/unit-operational-timezone.js";
import { registerStaffScheduleRoutes } from "./routes/staff-schedules.js";
import { registerUnitAssignmentPolicyRoutes } from "./routes/unit-assignment-policy.js";
import { registerMetaWebhookRoutes, type MetaWebhookOptions } from "./routes/meta-webhook.js";
import { registerChannelConnectionRoutes } from "./routes/channel-connections.js";
import { registerInboxEventsRoute, type InboxNotificationPool } from "./realtime/inbox-events.js";

const safeCorrelationId = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export interface BuildAppOptions {
  readonly identityVerifier?: IdentityVerifier;
  readonly pool?: TenantTransactionPool;
  readonly metaWebhook?: MetaWebhookOptions;
  readonly notificationPool?: InboxNotificationPool;
  readonly notificationConnectTimeoutMs?: number;
  readonly logger?: FastifyServerOptions["logger"];
  readonly releaseId?: string;
}

const unavailablePool: TenantTransactionPool = {
  async connect() { throw new Error("DATABASE_POOL_UNAVAILABLE"); },
};

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
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
  app.addHook("onRequest", async (request) => {
    request.log.info({ event: "http.request", method: request.method,
      route: request.routeOptions.url, requestId: request.id }, "http.request");
  });
  app.addHook("onResponse", async (request, reply) => {
    request.log.info({ event: "http.response", method: request.method,
      route: request.routeOptions.url, statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime), requestId: request.id }, "http.response");
  });
  app.addHook("onSend", async (request, reply) => {
    void reply.header("x-correlation-id", request.id);
    if (options.releaseId) void reply.header("x-zap-pronto-release", options.releaseId);
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
    let transactionStarted = false;
    try {
      connection = await (options.pool ?? unavailablePool).connect();
      await connection.query("BEGIN READ ONLY");
      transactionStarted = true;
      await connection.query("SET LOCAL ROLE zap_pronto_api");
      const result = await connection.query("SELECT session_user AS session_user, current_user AS current_user") as
        { readonly rows: readonly { readonly session_user?: unknown; readonly current_user?: unknown }[] };
      if (result.rows[0]?.session_user !== "zap_pronto_runtime" ||
          result.rows[0]?.current_user !== "zap_pronto_api") {
        throw new Error("DATABASE_RUNTIME_ROLE_UNAVAILABLE");
      }
      await connection.query("ROLLBACK");
      transactionStarted = false;
      return { status: "ok" as const };
    } catch {
      if (transactionStarted) {
        try { await connection?.query("ROLLBACK"); } catch { /* best effort */ }
      }
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
  registerInboxTeamAvailabilityRoute(app, options.pool ?? unavailablePool);
  registerInboxSlaAlertRoutes(app, options.pool ?? unavailablePool);
  registerUnitSlaPolicyRoutes(app, options.pool ?? unavailablePool);
  registerUnitCapacityAlertRoutes(app, options.pool ?? unavailablePool);
  registerUnitOperationalTimezoneRoutes(app, options.pool ?? unavailablePool);
  registerStaffScheduleRoutes(app, options.pool ?? unavailablePool);
  registerUnitAssignmentPolicyRoutes(app, options.pool ?? unavailablePool);
  registerChannelConnectionRoutes(app, options.pool ?? unavailablePool);
  registerInboxEventsRoute(app, options.pool ?? unavailablePool, options.notificationPool,
    options.notificationConnectTimeoutMs === undefined
      ? undefined
      : { notificationConnectTimeoutMs: options.notificationConnectTimeoutMs });
  await registerMetaWebhookRoutes(app, options.pool ?? unavailablePool, options.metaWebhook ?? { enabled: false });
  return app;
}
