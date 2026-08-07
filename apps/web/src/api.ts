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
  listAdministrativeUsers(...parameters: Parameters<typeof transportClient.listAdministrativeUsers>) {
    return transportClient.listAdministrativeUsers(...parameters);
  },
  listAdministrativeInvitations(...parameters: Parameters<typeof transportClient.listAdministrativeInvitations>) {
    return transportClient.listAdministrativeInvitations(...parameters);
  },
  changeAdministrativeUserStatus(...parameters: Parameters<typeof transportClient.changeAdministrativeUserStatus>) {
    return transportClient.changeAdministrativeUserStatus(...parameters);
  },
  revokeUserInvitation(...parameters: Parameters<typeof transportClient.revokeUserInvitation>) {
    return transportClient.revokeUserInvitation(...parameters);
  },
  reissueUserInvitation(...parameters: Parameters<typeof transportClient.reissueUserInvitation>) {
    return transportClient.reissueUserInvitation(...parameters);
  },
  acceptUserInvitation(...parameters: Parameters<typeof transportClient.acceptUserInvitation>) {
    return transportClient.acceptUserInvitation(...parameters);
  },
};
