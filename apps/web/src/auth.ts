import { UserManager, WebStorageStateStore } from "oidc-client-ts";

let manager: UserManager | undefined;
export function isAuthConfigured(): boolean { return manager !== undefined; }
export async function initializeAuth(): Promise<void> {
  const authority = import.meta.env.VITE_OIDC_AUTHORITY;
  const clientId = import.meta.env.VITE_OIDC_CLIENT_ID;
  if (!authority || !clientId) return;
  manager = new UserManager({ authority, client_id: clientId,
    redirect_uri: import.meta.env.VITE_OIDC_REDIRECT_URI ?? window.location.origin,
    response_type: "code", scope: import.meta.env.VITE_OIDC_SCOPE ?? "openid profile email",
    post_logout_redirect_uri: import.meta.env.VITE_OIDC_POST_LOGOUT_REDIRECT_URI ?? window.location.origin,
    automaticSilentRenew: import.meta.env.VITE_OIDC_AUTOMATIC_SILENT_RENEW === "true",
    userStore: new WebStorageStateStore({ store: window.sessionStorage }) });
  if (new URL(window.location.href).searchParams.has("code")) {
    await manager.signinRedirectCallback();
    window.history.replaceState({}, document.title, window.location.pathname);
  }
  window.__ZAP_PRONTO_AUTH__ = { getAccessToken: async () => (await manager?.getUser())?.access_token };
}
export async function signIn(): Promise<void> {
  if (!manager) throw new Error("OIDC_CONFIGURATION_REQUIRED");
  await manager.signinRedirect();
}
export async function clearAuthSession(): Promise<void> {
  await manager?.removeUser();
}
export async function signOut(): Promise<void> {
  const current = manager;
  if (!current) return;
  const user = await current.getUser();
  await current.removeUser();
  await current.signoutRedirect(user?.id_token ? { id_token_hint: user.id_token } : undefined);
}
