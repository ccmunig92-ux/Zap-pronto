const badRequest = new Set(["INVALID_IDEMPOTENCY_KEY", "INVALID_EMAIL", "INVALID_DISPLAY_NAME",
  "INVALID_PROVIDER_CODE", "INVALID_EXPIRATION", "INVALID_ASSIGNMENTS", "DUPLICATE_INVITATION_UNIT",
  "INVALID_INVITATION_COMMAND", "INVALID_INVITATION_ASSIGNMENTS", "INVALID_PAGE_LIMIT", "INVALID_PAGE_CURSOR",
  "INVALID_USER_VERSION", "INVALID_USER_STATUS_ACTION", "INVALID_LIFECYCLE_REASON", "INVALID_TARGET_ID",
  "INVALID_INVITATION_TOKEN", "VERIFIED_EMAIL_REQUIRED"]);
const conflict = new Set(["IDEMPOTENCY_CONFLICT", "USER_ALREADY_EXISTS", "INVITATION_ALREADY_PENDING",
  "INVITATION_NOT_PENDING", "USER_VERSION_CONFLICT", "LAST_TENANT_ADMIN_REQUIRED"]);
const notFound = new Set(["OIDC_PROVIDER_NOT_FOUND", "UNIT_NOT_FOUND", "USER_NOT_FOUND", "INVITATION_NOT_FOUND"]);
const forbidden = new Set(["AUTHORIZATION_DENIED", "SELF_ACCESS_REMOVAL_FORBIDDEN"]);
forbidden.add("INVITATION_ACCEPTANCE_DENIED");

export class InvitationRequestError extends Error {
  constructor(readonly code: string, readonly statusCode: 400 | 403 | 404 | 409) {
    super(code);
    this.name = "InvitationRequestError";
  }
  static from(error: unknown): unknown {
    const message = error instanceof Error ? error.message : "";
    const code = [...badRequest, ...conflict, ...notFound, ...forbidden].find((candidate) => message.includes(candidate));
    if (!code) return error;
    return new InvitationRequestError(code, badRequest.has(code) ? 400
      : forbidden.has(code) ? 403 : notFound.has(code) ? 404 : 409);
  }
}
