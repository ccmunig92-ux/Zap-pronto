export type AuthenticationFailure = "MISSING_BEARER" | "INVALID_BEARER" | "IDENTITY_REJECTED";

export class AuthenticationError extends Error {
  readonly statusCode = 401;
  readonly code: AuthenticationFailure;

  private constructor(code: AuthenticationFailure, message: string) {
    super(message);
    this.name = "AuthenticationError";
    this.code = code;
  }

  static missingBearer() { return new AuthenticationError("MISSING_BEARER", "Bearer token is required"); }
  static invalidBearer() { return new AuthenticationError("INVALID_BEARER", "Bearer authorization is malformed"); }
  static rejected() { return new AuthenticationError("IDENTITY_REJECTED", "Bearer token was rejected"); }
}

export class IdentityProviderUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = "IDENTITY_PROVIDER_UNAVAILABLE";

  constructor() {
    super("Identity verification is unavailable");
    this.name = "IdentityProviderUnavailableError";
  }
}

export class IdentityTokenRejectedError extends Error {
  readonly code = "IDENTITY_TOKEN_REJECTED";

  constructor() {
    super("Identity token rejected");
    this.name = "IdentityTokenRejectedError";
  }
}
