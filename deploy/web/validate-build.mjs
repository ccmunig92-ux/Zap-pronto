import { writeFileSync } from "node:fs";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function httpsUrl(name, optional = false) {
  const raw = process.env[name]?.trim();
  if (!raw && optional) return undefined;
  let parsed;
  try { parsed = new URL(required(name)); } catch { throw new Error(`${name}_VALID_HTTPS_URL_REQUIRED`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${name}_VALID_HTTPS_URL_REQUIRED`);
  }
  return parsed;
}

const authority = httpsUrl("VITE_OIDC_AUTHORITY");
required("VITE_OIDC_CLIENT_ID");
required("VITE_OIDC_SCOPE");
httpsUrl("VITE_OIDC_REDIRECT_URI");
httpsUrl("VITE_OIDC_POST_LOGOUT_REDIRECT_URI", true);
if (!new Set(["true", "false"]).has(required("VITE_OIDC_AUTOMATIC_SILENT_RENEW"))) {
  throw new Error("VITE_OIDC_AUTOMATIC_SILENT_RENEW_INVALID");
}
writeFileSync("/workspace/oidc-authority-origin", authority.origin, { encoding: "utf8", mode: 0o444 });
