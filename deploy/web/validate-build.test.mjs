import assert from "node:assert/strict";
import test from "node:test";
import { validateBuild } from "./validate-build.mjs";

function validEnvironment(overrides = {}) {
  return {
    VITE_OIDC_AUTHORITY: "https://identity.example.test",
    VITE_OIDC_CLIENT_ID: "web-client",
    VITE_OIDC_SCOPE: "openid profile email",
    VITE_OIDC_REDIRECT_URI: "https://app.example.test/oidc/callback",
    VITE_OIDC_POST_LOGOUT_REDIRECT_URI: "https://app.example.test/logout",
    VITE_OIDC_AUTOMATIC_SILENT_RENEW: "false",
    ...overrides,
  };
}

test("accepts callback and logout paths on the same HTTPS origin", () => {
  assert.deepEqual(validateBuild(validEnvironment()), { authorityOrigin: "https://identity.example.test" });
  assert.doesNotThrow(() => validateBuild(validEnvironment({ VITE_OIDC_POST_LOGOUT_REDIRECT_URI: "" })));
});

test("rejects a logout origin with a different host or port", () => {
  for (const logout of ["https://other.example.test/logout", "https://app.example.test:444/logout"]) {
    assert.throws(
      () => validateBuild(validEnvironment({ VITE_OIDC_POST_LOGOUT_REDIRECT_URI: logout })),
      /VITE_OIDC_POST_LOGOUT_REDIRECT_URI_SAME_ORIGIN_REQUIRED/,
    );
  }
});

test("rejects HTTP, query strings and fragments in redirect URLs", () => {
  for (const redirect of [
    "http://app.example.test/oidc/callback",
    "https://app.example.test/oidc/callback?return=unsafe",
    "https://app.example.test/oidc/callback#token",
  ]) {
    assert.throws(
      () => validateBuild(validEnvironment({ VITE_OIDC_REDIRECT_URI: redirect })),
      /VITE_OIDC_REDIRECT_URI_VALID_HTTPS_URL_REQUIRED/,
    );
  }
});
