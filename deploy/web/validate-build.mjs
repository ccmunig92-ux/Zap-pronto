import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function httpsUrl(environment, name, optional = false) {
  const raw = environment[name]?.trim();
  if (!raw && optional) return undefined;
  let parsed;
  try { parsed = new URL(required(environment, name)); }
  catch { throw new Error(`${name}_VALID_HTTPS_URL_REQUIRED`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name}_VALID_HTTPS_URL_REQUIRED`);
  }
  return parsed;
}

export function validateBuild(environment) {
  const authority = httpsUrl(environment, "VITE_OIDC_AUTHORITY");
  required(environment, "VITE_OIDC_CLIENT_ID");
  required(environment, "VITE_OIDC_SCOPE");
  const redirectUri = httpsUrl(environment, "VITE_OIDC_REDIRECT_URI");
  const postLogoutRedirectUri = httpsUrl(environment, "VITE_OIDC_POST_LOGOUT_REDIRECT_URI", true);
  if (postLogoutRedirectUri && postLogoutRedirectUri.origin !== redirectUri.origin) {
    throw new Error("VITE_OIDC_POST_LOGOUT_REDIRECT_URI_SAME_ORIGIN_REQUIRED");
  }
  if (!new Set(["true", "false"]).has(required(environment, "VITE_OIDC_AUTOMATIC_SILENT_RENEW"))) {
    throw new Error("VITE_OIDC_AUTOMATIC_SILENT_RENEW_INVALID");
  }
  return { authorityOrigin: authority.origin };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { authorityOrigin } = validateBuild(process.env);
  writeFileSync("/workspace/oidc-authority-origin", authorityOrigin, { encoding: "utf8", mode: 0o444 });
}
