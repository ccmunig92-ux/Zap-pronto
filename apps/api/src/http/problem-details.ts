import type { FastifyInstance } from "fastify";
import { AuthenticationError, IdentityProviderUnavailableError } from "../auth/errors.js";
import { AuthorizationDeniedError } from "../authorization/authorize.js";

export function registerProblemDetailsHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AuthenticationError || error instanceof IdentityProviderUnavailableError
      || error instanceof AuthorizationDeniedError) {
      void reply.status(error.statusCode).type("application/problem+json").send({
        type: `urn:zap-pronto:error:${error.code.toLowerCase().replaceAll("_", "-")}`,
        title: error.statusCode === 401 ? "Unauthorized"
          : error.statusCode === 403 ? "Forbidden" : "Service Unavailable",
        status: error.statusCode,
        detail: error.message,
        correlationId: request.id,
      });
      return;
    }
    void reply.status(500).type("application/problem+json").send({
      type: "urn:zap-pronto:error:internal-server-error",
      title: "Internal Server Error",
      status: 500,
      detail: "An unexpected error occurred",
      correlationId: request.id,
    });
  });
}
