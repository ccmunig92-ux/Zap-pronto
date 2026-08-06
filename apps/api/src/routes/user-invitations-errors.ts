const badRequest = new Set(["INVALID_IDEMPOTENCY_KEY", "INVALID_EMAIL", "INVALID_DISPLAY_NAME",
  "INVALID_PROVIDER_CODE", "INVALID_EXPIRATION", "INVALID_ASSIGNMENTS", "DUPLICATE_INVITATION_UNIT",
  "INVALID_INVITATION_COMMAND", "INVALID_INVITATION_ASSIGNMENTS"]);
const conflict = new Set(["IDEMPOTENCY_CONFLICT", "USER_ALREADY_EXISTS", "INVITATION_ALREADY_PENDING"]);
const notFound = new Set(["OIDC_PROVIDER_NOT_FOUND", "UNIT_NOT_FOUND"]);

export class InvitationRequestError extends Error {
  constructor(readonly code: string, readonly statusCode: 400 | 404 | 409) {
    super(code);
    this.name = "InvitationRequestError";
  }
  static from(error: unknown): unknown {
    const message = error instanceof Error ? error.message : "";
    const code = [...badRequest, ...conflict, ...notFound].find((candidate) => message.includes(candidate));
    if (!code) return error;
    return new InvitationRequestError(code, badRequest.has(code) ? 400 : notFound.has(code) ? 404 : 409);
  }
}
