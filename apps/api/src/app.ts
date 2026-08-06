import Fastify from "fastify";
import swagger from "@fastify/swagger";
import { HealthSchema, ProblemDetailsSchema } from "@zap-pronto/contracts";
import { randomUUID } from "node:crypto";

const safeCorrelationId = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export async function buildApp() {
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
  app.addHook("onSend", async (request, reply) => {
    void reply.header("x-correlation-id", request.id);
  });
  app.get("/health/live", {
    schema: { operationId: "getHealthLive", response: { 200: HealthSchema } },
  }, async () => ({ status: "ok" as const }));
  return app;
}
