import { createApiClient } from "@zap-pronto/api-client";

declare global {
  interface Window {
    __ZAP_PRONTO_AUTH__?: { getAccessToken(): Promise<string | undefined> };
  }
}

const transportClient = createApiClient({
  baseUrl: window.location.origin,
  getAccessToken: async () => window.__ZAP_PRONTO_AUTH__?.getAccessToken(),
});
let pendingCurrentUser: ReturnType<typeof transportClient.getCurrentUser> | undefined;
export const apiClient = {
  getCurrentUser() {
    pendingCurrentUser ??= transportClient.getCurrentUser().catch((error: unknown) => {
      pendingCurrentUser = undefined;
      throw error;
    });
    return pendingCurrentUser;
  },
  getUserInvitationOptions() {
    return transportClient.getUserInvitationOptions();
  },
  createUserInvitation(...parameters: Parameters<typeof transportClient.createUserInvitation>) {
    return transportClient.createUserInvitation(...parameters);
  },
};
