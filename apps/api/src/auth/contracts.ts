export interface ExternalIdentity {
  readonly issuer: string;
  readonly subject: string;
}

export interface IdentityVerifier {
  verifyBearer(token: string): Promise<ExternalIdentity>;
}
