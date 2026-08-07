export interface OidcRuntimeConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  readonly discoveryUrl: string;
  readonly organizationClaim?: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`OIDC_CONFIGURATION_INVALID:${name}_REQUIRED`);
  return value;
}

function secureUrl(value: string, name: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`OIDC_CONFIGURATION_INVALID:${name}_URL`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`OIDC_CONFIGURATION_INVALID:${name}_UNSAFE`);
  }
  return parsed;
}

export function loadOidcRuntimeConfig(env: Environment = process.env): OidcRuntimeConfig {
  const issuer = required(env, "OIDC_ISSUER");
  const audience = required(env, "OIDC_AUDIENCE");
  const jwksUrl = required(env, "OIDC_JWKS_URL");
  const issuerUrl = secureUrl(issuer, "OIDC_ISSUER");
  secureUrl(jwksUrl, "OIDC_JWKS_URL");
  if (audience.length > 512 || /\s/.test(audience)) {
    throw new Error("OIDC_CONFIGURATION_INVALID:OIDC_AUDIENCE_FORMAT");
  }
  const organizationClaim = env.OIDC_ORGANIZATION_CLAIM?.trim();
  if (organizationClaim && !/^[A-Za-z][A-Za-z0-9_.:-]{0,126}$/.test(organizationClaim)) {
    throw new Error("OIDC_CONFIGURATION_INVALID:OIDC_ORGANIZATION_CLAIM_FORMAT");
  }
  const discoveryUrl = env.OIDC_DISCOVERY_URL?.trim()
    || new URL(`${issuerUrl.pathname.replace(/\/$/, "")}/.well-known/openid-configuration`, issuerUrl.origin).href;
  secureUrl(discoveryUrl, "OIDC_DISCOVERY_URL");
  return { issuer, audience, jwksUrl, discoveryUrl, ...(organizationClaim ? { organizationClaim } : {}) };
}

interface ProbeOptions { readonly fetch?: typeof fetch; readonly timeoutMs?: number }

async function getJson(url: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<unknown> {
  const response = await fetchImpl(url, { method: "GET", redirect: "error", signal,
    headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`OIDC_READINESS_FAILED:HTTP_${response.status}`);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) throw new Error("OIDC_READINESS_FAILED:CONTENT_TYPE");
  try { return await response.json(); } catch { throw new Error("OIDC_READINESS_FAILED:INVALID_JSON"); }
}

export async function probeOidcReadiness(config: OidcRuntimeConfig, options: ProbeOptions = {}): Promise<void> {
  const fetchImpl = options.fetch ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  try {
    const discovery = await getJson(config.discoveryUrl, fetchImpl, controller.signal);
    if (!discovery || typeof discovery !== "object") throw new Error("OIDC_READINESS_FAILED:DISCOVERY_SHAPE");
    const record = discovery as Record<string, unknown>;
    if (record.issuer !== config.issuer) throw new Error("OIDC_READINESS_FAILED:ISSUER_MISMATCH");
    if (record.jwks_uri !== config.jwksUrl) throw new Error("OIDC_READINESS_FAILED:JWKS_URI_MISMATCH");
    const jwks = await getJson(config.jwksUrl, fetchImpl, controller.signal);
    if (!jwks || typeof jwks !== "object" || !Array.isArray((jwks as { keys?: unknown }).keys)) {
      throw new Error("OIDC_READINESS_FAILED:JWKS_SHAPE");
    }
    const usableKeys = (jwks as { keys: unknown[] }).keys.filter((key) => {
      if (!key || typeof key !== "object") return false;
      const value = key as Record<string, unknown>;
      const keyOperations = value.key_ops;
      return value.kty === "RSA" && (value.alg === undefined || value.alg === "RS256")
        && (value.use === undefined || value.use === "sig")
        && (keyOperations === undefined || (Array.isArray(keyOperations) && keyOperations.includes("verify")))
        && typeof value.kid === "string" && value.kid.length > 0 && !("d" in value);
    });
    if (usableKeys.length === 0) throw new Error("OIDC_READINESS_FAILED:NO_SIGNING_KEYS");
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("OIDC_READINESS_FAILED:TIMEOUT");
    throw error;
  } finally { clearTimeout(timeout); }
}
