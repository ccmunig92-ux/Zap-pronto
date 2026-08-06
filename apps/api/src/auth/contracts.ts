export interface ExternalIdentity {
  readonly issuer: string;
  readonly audience: string;
  readonly subject: string;
  readonly organization?: {
    readonly claim: string;
    readonly value: string;
  };
}

export interface IdentityVerifier {
  verifyBearer(token: string): Promise<ExternalIdentity>;
}
