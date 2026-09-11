import { createRemoteJWKSet, jwtVerify } from "jose";
import type { IdentityVerifier } from "./contracts.js";
import { IdentityTokenRejectedError } from "./errors.js";

export interface OidcVerifierOptions {
  readonly issuer: string; readonly audience: string; readonly jwksUrl: string;
  readonly organizationClaim?: string;
  readonly emailClaim?: string;
  readonly emailVerifiedClaim?: string;
  readonly algorithms?: readonly ("RS256" | "ES256")[];
}
const rejectedCodes = new Set(["ERR_JWT_EXPIRED", "ERR_JWT_CLAIM_VALIDATION_FAILED", "ERR_JWT_INVALID",
  "ERR_JOSE_ALG_NOT_ALLOWED", "ERR_JWS_INVALID", "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWKS_NO_MATCHING_KEY"]);

function normalizedVerifiedEmail(value: unknown, verified: unknown): string | undefined {
  if (typeof value !== "string" || verified !== true) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

export function createOidcIdentityVerifier(options: OidcVerifierOptions): IdentityVerifier {
  const jwks = createRemoteJWKSet(new URL(options.jwksUrl));
  const emailClaim = options.emailClaim ?? "email";
  const emailVerifiedClaim = options.emailVerifiedClaim ?? "email_verified";
  return { async verifyBearer(token) {
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer: options.issuer, audience: options.audience,
        algorithms: [...(options.algorithms ?? ["RS256"])] });
      if (typeof payload.sub !== "string" || payload.sub.length === 0 || typeof payload.exp !== "number") {
        throw new IdentityTokenRejectedError();
      }
      const email = payload[emailClaim];
      const verifiedEmail = normalizedVerifiedEmail(email, payload[emailVerifiedClaim]);
      if (!options.organizationClaim) return {
        issuer: options.issuer, audience: options.audience, subject: payload.sub,
        ...(verifiedEmail ? { verifiedEmail } : {}),
      };
      const organizationValue = payload[options.organizationClaim];
      if (typeof organizationValue !== "string" || organizationValue.length === 0) {
        throw new IdentityTokenRejectedError();
      }
      return { issuer: options.issuer, audience: options.audience, subject: payload.sub,
        ...(verifiedEmail ? { verifiedEmail } : {}),
        organization: { claim: options.organizationClaim, value: organizationValue } };
    } catch (error) {
      if (error instanceof IdentityTokenRejectedError) throw error;
      if (typeof error === "object" && error !== null && "code" in error
        && rejectedCodes.has(String(error.code))) throw new IdentityTokenRejectedError();
      throw error;
    }
  } };
}
