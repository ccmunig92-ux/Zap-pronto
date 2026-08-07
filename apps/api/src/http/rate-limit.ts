export class RateLimitExceededError extends Error {
  readonly statusCode = 429;
  readonly code = "RATE_LIMIT_EXCEEDED";
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super("Too many invitation acceptance attempts");
    this.name = "RateLimitExceededError";
    this.retryAfterSeconds = Number.isInteger(retryAfterSeconds) && retryAfterSeconds > 0
      ? Math.min(retryAfterSeconds, 86_400) : 1;
  }
}
