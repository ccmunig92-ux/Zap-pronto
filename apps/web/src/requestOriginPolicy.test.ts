import { describe, expect, it } from "vitest";
import { isExpectedBrowserOrigin } from "./requestOriginPolicy.js";

describe("isExpectedBrowserOrigin", () => {
  const applicationOrigin = "https://staging.example.com";
  const oidcIssuer = "https://tenant.us.auth0.com/";

  it("permite a aplicacao e qualquer endpoint da origem OIDC exata", () => {
    expect(isExpectedBrowserOrigin("https://staging.example.com/v1/me", applicationOrigin, oidcIssuer)).toBe(true);
    expect(isExpectedBrowserOrigin("https://tenant.us.auth0.com/.well-known/openid-configuration", applicationOrigin, oidcIssuer)).toBe(true);
    expect(isExpectedBrowserOrigin("https://tenant.us.auth0.com/authorize", applicationOrigin, oidcIssuer)).toBe(true);
    expect(isExpectedBrowserOrigin("https://tenant.us.auth0.com/oauth/token", applicationOrigin, oidcIssuer)).toBe(true);
  });

  it("rejeita hosts arbitrarios e imitacoes do hostname OIDC", () => {
    expect(isExpectedBrowserOrigin("https://evil.example/collect", applicationOrigin, oidcIssuer)).toBe(false);
    expect(isExpectedBrowserOrigin("https://tenant.us.auth0.com.evil.example/authorize", applicationOrigin, oidcIssuer)).toBe(false);
    expect(isExpectedBrowserOrigin("https://meta.example/messages", applicationOrigin, oidcIssuer)).toBe(false);
  });

  it("nao permite origem OIDC quando o issuer nao foi configurado", () => {
    expect(isExpectedBrowserOrigin("https://tenant.us.auth0.com/authorize", applicationOrigin, undefined)).toBe(false);
  });
});
