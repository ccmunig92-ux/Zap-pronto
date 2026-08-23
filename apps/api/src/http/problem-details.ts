import type { FastifyInstance } from "fastify";
import { AuthenticationError, IdentityProviderUnavailableError } from "../auth/errors.js";
import { AuthorizationDeniedError } from "../authorization/authorize.js";
import { AccountNotAssignedError } from "@zap-pronto/core/database/current-user";
import { InvitationRequestError } from "../routes/user-invitations-errors.js";
import { RateLimitExceededError } from "./rate-limit.js";
import { InboxHandoffRequestError } from "../routes/inbox-handoffs-errors.js";
import { InboxRoutingRequiredError } from "../routes/inbox-routing-required-errors.js";
import { InboxConversationRequestError } from "../routes/inbox-conversations-errors.js";
import { AvailabilityError } from "../routes/inbox-availability.js";
import { SlaAlertError } from "../routes/inbox-sla-alerts.js";
import { SlaPolicyError } from "../routes/unit-sla-policy.js";
import { UnitOperationalTimezoneError } from "../routes/unit-operational-timezone.js";
import { StaffScheduleError } from "../routes/staff-schedules.js";
import { AssignmentPolicyError } from "../routes/unit-assignment-policy.js";
import { CapacityAlertError } from "../routes/unit-capacity-alert.js";

export function registerProblemDetailsHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (typeof error === "object" && error !== null && "validation" in error && error.validation) {
      void reply.status(400).type("application/problem+json").send({
        type: "urn:zap-pronto:error:invalid-request", title: "Bad Request", status: 400,
        detail: "The request does not match the API contract", correlationId: request.id,
      });
      return;
    }
    if (error instanceof RateLimitExceededError) {
      void reply.header("retry-after", String(error.retryAfterSeconds)).header("cache-control", "no-store").status(429)
        .type("application/problem+json").send({ type: "urn:zap-pronto:error:rate-limit-exceeded",
          title: "Too Many Requests", status: 429, detail: error.message, correlationId: request.id });
      return;
    }
    if (error instanceof AuthenticationError || error instanceof IdentityProviderUnavailableError
      || error instanceof AuthorizationDeniedError || error instanceof AccountNotAssignedError
      || error instanceof InvitationRequestError || error instanceof InboxHandoffRequestError
      || error instanceof InboxRoutingRequiredError || error instanceof InboxConversationRequestError
      || error instanceof AvailabilityError || error instanceof SlaAlertError || error instanceof SlaPolicyError
      || error instanceof UnitOperationalTimezoneError || error instanceof StaffScheduleError || error instanceof AssignmentPolicyError
      || error instanceof CapacityAlertError) {
      void reply.status(error.statusCode).type("application/problem+json").send({
        type: `urn:zap-pronto:error:${error.code.toLowerCase().replaceAll("_", "-")}`,
        title: error.statusCode === 401 ? "Unauthorized"
          : error.statusCode === 403 ? "Forbidden"
            : error.statusCode === 404 ? "Not Found"
              : error.statusCode === 409 ? "Conflict"
                : error.statusCode === 422 ? "Unprocessable Content"
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
