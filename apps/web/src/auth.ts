import { InMemoryWebStorage, UserManager, WebStorageStateStore } from "oidc-client-ts";

let manager: UserManager | undefined;
let retryInitialization: Promise<AuthInitializationResult> | undefined;
// The access/ID tokens must remain process-local. Only the PKCE interaction
// state is persisted in sessionStorage so a redirect can safely round-trip.
const inMemoryUserStore = new WebStorageStateStore({ store: new InMemoryWebStorage() });
const sessionMarkerKey = "zap-pronto.auth.session";
function hasSessionMarker(): boolean {
  try { return window.sessionStorage.getItem(sessionMarkerKey) === "1"; } catch { return false; }
}
function markSession(): void {
  try { window.sessionStorage.setItem(sessionMarkerKey, "1"); } catch { /* storage can be disabled */ }
}
function clearSessionMarker(): void {
  try { window.sessionStorage.removeItem(sessionMarkerKey); } catch { /* storage can be disabled */ }
}
export type AuthInitializationResult =
  { status: "ready" } | { status: "error" } | { status: "redirecting" } | { status: "blocked" };
export function isAuthConfigured(): boolean { return manager !== undefined; }
export function shouldMountAfterAuthInitialization(result: AuthInitializationResult): boolean {
  return result.status !== "redirecting" && result.status !== "blocked";
}
function clearCallbackUrl(url: URL): "cleared" | "redirecting" | "blocked" {
  try {
    window.history.replaceState({}, document.title, url.pathname);
    return "cleared";
  } catch {
    try {
      window.location.replace(url.pathname);
      return "redirecting";
    } catch {
      return "blocked";
    }
  }
}
export async function initializeAuth(): Promise<AuthInitializationResult> {
  let candidate: UserManager | undefined;
  try {
    const authority = import.meta.env.VITE_OIDC_AUTHORITY;
    const clientId = import.meta.env.VITE_OIDC_CLIENT_ID;
    if (!authority || !clientId) return { status: "ready" };
    const callbackUrl = new URL(window.location.href);
    const hasCallback = callbackUrl.searchParams.has("code") || callbackUrl.searchParams.has("error");
    const originalCallbackUrl = callbackUrl.href;
    if (hasCallback) {
      const clearing = clearCallbackUrl(callbackUrl);
      if (clearing !== "cleared") return { status: clearing };
    }
    const audience = import.meta.env.VITE_OIDC_AUDIENCE?.trim();
    const redirectUri = import.meta.env.VITE_OIDC_REDIRECT_URI ?? window.location.origin;
    candidate = new UserManager({ authority, client_id: clientId,
      ...(audience ? { extraQueryParams: { audience } } : {}),
      redirect_uri: redirectUri, silent_redirect_uri: redirectUri,
      response_type: "code", scope: import.meta.env.VITE_OIDC_SCOPE ?? "openid profile email",
      post_logout_redirect_uri: import.meta.env.VITE_OIDC_POST_LOGOUT_REDIRECT_URI ?? window.location.origin,
      automaticSilentRenew: import.meta.env.VITE_OIDC_AUTOMATIC_SILENT_RENEW === "true",
      maxSilentRenewTimeoutRetries: 0,
      stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
      userStore: inMemoryUserStore });
    if (hasCallback) {
      const callbackUser = await candidate.signinCallback(originalCallbackUrl);
      if (!callbackUser) return { status: "redirecting" };
      markSession();
    } else if (hasSessionMarker() && !(await candidate.getUser())) {
      try {
        await candidate.signinSilent({ forceIframeAuth: true });
      } catch {
        clearSessionMarker();
        try { await candidate.removeUser(); } catch { /* cleanup is best effort */ }
      }
    }
    manager = candidate;
    window.__ZAP_PRONTO_AUTH__ = { getAccessToken: async () => (await manager?.getUser())?.access_token };
    return { status: "ready" };
  } catch {
    try { await candidate?.removeUser(); } catch { /* cleanup is best effort */ }
    clearSessionMarker();
    manager = undefined;
    delete window.__ZAP_PRONTO_AUTH__;
    return { status: "error" };
  }
}
export async function retryAuthInitialization(): Promise<AuthInitializationResult> {
  if (retryInitialization) return retryInitialization;
  retryInitialization = (async () => {
    const current = manager;
    manager = undefined;
    delete window.__ZAP_PRONTO_AUTH__;
    await current?.removeUser();
    await current?.clearStaleState();
    return initializeAuth();
  })().catch(() => ({ status: "error" as const })).finally(() => { retryInitialization = undefined; });
  return retryInitialization;
}
export async function signIn(): Promise<void> {
  if (!manager) throw new Error("OIDC_CONFIGURATION_REQUIRED");
  await manager.signinRedirect();
}
export async function clearAuthSession(): Promise<void> {
  clearSessionMarker();
  await manager?.removeUser();
}
export async function signOut(): Promise<void> {
  const current = manager;
  if (!current) return;
  const user = await current.getUser();
  clearSessionMarker();
  await current.removeUser();
  await current.signoutRedirect(user?.id_token ? { id_token_hint: user.id_token } : undefined);
}
