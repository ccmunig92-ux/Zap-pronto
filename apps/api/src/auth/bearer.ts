import { AuthenticationError } from "./errors.js";

// RFC 6750 b64token: one or more token characters, with optional trailing padding.
const bearerPattern = /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/;

export function parseBearerAuthorization(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw AuthenticationError.missingBearer();
  const match = bearerPattern.exec(value);
  if (!match?.[1]) throw AuthenticationError.invalidBearer();
  return match[1];
}
