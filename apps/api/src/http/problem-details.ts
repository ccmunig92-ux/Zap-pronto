import type { FastifyInstance } from "fastify";
import { AuthenticationError, IdentityProviderUnavailableError } from "../auth/errors.js";
import { AuthorizationDeniedError } from "../authorization/authorize.js";
import { AccountNotAssignedError } from "@zap-pronto/core/database/current-user";
import { InvitationRequestError } from "../routes/user-invitations-errors.js";

export function registerProblemDetailsHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (typeof error === "object" && error !== null && "validation" in error && error.validation) {
      void reply.status(400).type("application/problem+json").send({
        type: "urn:zap-pronto:error:invalid-request", title: "Bad Request", status: 400,
        detail: "The request does not match the API contract", correlationId: request.id,
      });
      return;
    }
    if (error instanceof AuthenticationError || error instanceof IdentityProviderUnavailableError
      || error instanceof AuthorizationDeniedError || error instanceof AccountNotAssignedError
      || error instanceof InvitationRequestError) {
      void reply.status(error.statusCode).type("application/problem+json").send({
        type: `urn:zap-pronto:error:${error.code.toLowerCase().replaceAll("_", "-")}`,
        title: error.statusCode === 401 ? "Unauthorized"
          : error.statusCode === 403 ? "Forbidden"
            : error.statusCode === 404 ? "Not Found"
              : error.statusCode === 409 ? "Conflict"
                : error.statusCode === 400 ? "Bad Request" : "Service Unavailable",
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
