export class InboxHandoffRequestError extends Error {
  private constructor(readonly statusCode: 400 | 404 | 409, readonly code: string) {
    super(code);
  }

  static from(error: unknown): never {
    if (error instanceof InboxHandoffRequestError) throw error;
    const code = error instanceof Error ? error.message : "";
    if (["INVALID_IDEMPOTENCY_KEY", "INVALID_EXPECTED_VERSION", "INVALID_UNIT_ID",
      "INVALID_PAGE_LIMIT", "INVALID_PAGE_CURSOR","INVALID_HANDOFF_FILTER","INVALID_HANDOFF_CLOCK","INVALID_HANDOFF_RESOLVE_REQUEST","INVALID_HANDOFF_REOPEN_REQUEST","INVALID_HANDOFF_REQUEUE_REQUEST","INVALID_HANDOFF_TRANSFER_REQUEST","INVALID_HANDOFF_TAKEOVER_REQUEST","INVALID_SUPERVISED_HANDOFF_LIST_REQUEST"].includes(code)) {
      throw new InboxHandoffRequestError(400, "INVALID_REQUEST");
    }
    if (["HANDOFF_NOT_FOUND","HANDOFF_RESOLVE_NOT_FOUND","HANDOFF_REOPEN_NOT_FOUND","HANDOFF_REQUEUE_NOT_FOUND","HANDOFF_TRANSFER_NOT_FOUND","HANDOFF_TAKEOVER_NOT_FOUND","SUPERVISED_HANDOFF_LIST_NOT_FOUND"].includes(code)) throw new InboxHandoffRequestError(404, "RESOURCE_NOT_FOUND");
    if (["HANDOFF_CLAIM_CONFLICT", "HANDOFF_AGGREGATE_INCONSISTENT", "IDEMPOTENCY_KEY_REUSED","HANDOFF_RESOLVE_CONFLICT","HANDOFF_RESOLVE_IDEMPOTENCY_CONFLICT"].includes(code)) {
      throw new InboxHandoffRequestError(409, "HANDOFF_CONFLICT");
    }
    if (["HANDOFF_REQUEUE_CONFLICT","HANDOFF_REQUEUE_IDEMPOTENCY_CONFLICT","HANDOFF_REQUEUE_PENDING_OUTBOUND"].includes(code)) throw new InboxHandoffRequestError(409,"HANDOFF_CONFLICT");
    if (["HANDOFF_REOPEN_CONFLICT","HANDOFF_REOPEN_IDEMPOTENCY_CONFLICT"].includes(code)) throw new InboxHandoffRequestError(409,"HANDOFF_CONFLICT");
    if (["HANDOFF_TRANSFER_CONFLICT","HANDOFF_TRANSFER_IDEMPOTENCY_CONFLICT","ASSIGNEE_NOT_ELIGIBLE","ASSIGNEE_NOT_AVAILABLE","ASSIGNEE_OUTSIDE_SHIFT"].includes(code)) throw new InboxHandoffRequestError(409,"HANDOFF_CONFLICT");
    if (["HANDOFF_TAKEOVER_CONFLICT","HANDOFF_TAKEOVER_IDEMPOTENCY_CONFLICT","HANDOFF_TAKEOVER_PENDING_OUTBOUND","ASSIGNEE_NOT_AVAILABLE","ASSIGNEE_OUTSIDE_SHIFT"].includes(code)) throw new InboxHandoffRequestError(409,"HANDOFF_CONFLICT");
    throw error;
  }

  static notFound(): InboxHandoffRequestError {
    return new InboxHandoffRequestError(404, "RESOURCE_NOT_FOUND");
  }

  static outsideShift(): InboxHandoffRequestError {
    return new InboxHandoffRequestError(409, "ASSIGNMENT_OUTSIDE_SHIFT");
  }
}
