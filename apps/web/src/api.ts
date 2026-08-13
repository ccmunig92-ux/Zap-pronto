import { createApiClient } from "@zap-pronto/api-client";

declare global {
  interface Window {
    __ZAP_PRONTO_AUTH__?: { getAccessToken(): Promise<string | undefined> };
  }
}

let pendingAccessToken:Promise<string|undefined>|undefined;
export function getAccessTokenSingleFlight():Promise<string|undefined>{
  if(!pendingAccessToken){
    const request=window.__ZAP_PRONTO_AUTH__?.getAccessToken()??Promise.resolve(undefined);
    pendingAccessToken=request;
    request.finally(()=>{if(pendingAccessToken===request)pendingAccessToken=undefined}).catch(()=>undefined);
  }
  return pendingAccessToken;
}

const transportClient = createApiClient({
  baseUrl: window.location.origin,
  getAccessToken: getAccessTokenSingleFlight,
});
let pendingCurrentUser: ReturnType<typeof transportClient.getCurrentUser> | undefined;
export const apiClient = {
  getCurrentUser() {
    if (!pendingCurrentUser) {
      const request = transportClient.getCurrentUser();
      pendingCurrentUser = request;
      request.then(() => {
        if (pendingCurrentUser === request) pendingCurrentUser = undefined;
      }, () => {
        if (pendingCurrentUser === request) pendingCurrentUser = undefined;
      });
    }
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
  changeUnitMembership(...parameters:Parameters<typeof transportClient.changeUnitMembership>){
    return transportClient.changeUnitMembership(...parameters);
  },
  listUnitMemberships(...parameters:Parameters<typeof transportClient.listUnitMemberships>){
    return transportClient.listUnitMemberships(...parameters);
  },
  getUnitSlaPolicy(...parameters:Parameters<typeof transportClient.getUnitSlaPolicy>){
    return transportClient.getUnitSlaPolicy(...parameters);
  },
  setUnitSlaPolicy(...parameters:Parameters<typeof transportClient.setUnitSlaPolicy>){
    return transportClient.setUnitSlaPolicy(...parameters);
  },
  getUnitOperationalTimezone(...parameters:Parameters<typeof transportClient.getUnitOperationalTimezone>){
    return transportClient.getUnitOperationalTimezone(...parameters);
  },
  setUnitOperationalTimezone(...parameters:Parameters<typeof transportClient.setUnitOperationalTimezone>){
    return transportClient.setUnitOperationalTimezone(...parameters);
  },
  listShiftMembers(...parameters:Parameters<typeof transportClient.listShiftMembers>){return transportClient.listShiftMembers(...parameters)},
  getStaffSchedule(...parameters:Parameters<typeof transportClient.getStaffSchedule>){return transportClient.getStaffSchedule(...parameters)},
  getEffectiveStaffShift(...parameters:Parameters<typeof transportClient.getEffectiveStaffShift>){return transportClient.getEffectiveStaffShift(...parameters)},
  setStaffSchedule(...parameters:Parameters<typeof transportClient.setStaffSchedule>){return transportClient.setStaffSchedule(...parameters)},
  revokeUserInvitation(...parameters: Parameters<typeof transportClient.revokeUserInvitation>) {
    return transportClient.revokeUserInvitation(...parameters);
  },
  reissueUserInvitation(...parameters: Parameters<typeof transportClient.reissueUserInvitation>) {
    return transportClient.reissueUserInvitation(...parameters);
  },
  acceptUserInvitation(...parameters: Parameters<typeof transportClient.acceptUserInvitation>) {
    return transportClient.acceptUserInvitation(...parameters);
  },
  listRoutingRequired(...parameters:Parameters<typeof transportClient.listRoutingRequired>){
    return transportClient.listRoutingRequired(...parameters);
  },
  resolveRoutingRequired(...parameters:Parameters<typeof transportClient.resolveRoutingRequired>){
    return transportClient.resolveRoutingRequired(...parameters);
  },
  listHandoffs(...parameters:Parameters<typeof transportClient.listHandoffs>){return transportClient.listHandoffs(...parameters)},
  getInboxAvailability(...parameters:Parameters<typeof transportClient.getInboxAvailability>){return transportClient.getInboxAvailability(...parameters)},
  setInboxAvailability(...parameters:Parameters<typeof transportClient.setInboxAvailability>){return transportClient.setInboxAvailability(...parameters)},
  listInboxTeamAvailability(...parameters:Parameters<typeof transportClient.listInboxTeamAvailability>){return transportClient.listInboxTeamAvailability(...parameters)},
  claimHandoff(...parameters:Parameters<typeof transportClient.claimHandoff>){return transportClient.claimHandoff(...parameters)},
  resolveHandoff(...parameters:Parameters<typeof transportClient.resolveHandoff>){return transportClient.resolveHandoff(...parameters)},
  requeueHandoff(...parameters:Parameters<typeof transportClient.requeueHandoff>){return transportClient.requeueHandoff(...parameters)},
  listInboxHandoffTransferCandidates(...parameters:Parameters<typeof transportClient.listInboxHandoffTransferCandidates>){return transportClient.listInboxHandoffTransferCandidates(...parameters)},
  transferInboxHandoff(...parameters:Parameters<typeof transportClient.transferInboxHandoff>){return transportClient.transferInboxHandoff(...parameters)},
  takeoverInboxHandoff(...parameters:Parameters<typeof transportClient.takeoverInboxHandoff>){return transportClient.takeoverInboxHandoff(...parameters)},
  listActiveInboxHandoffs(...parameters:Parameters<typeof transportClient.listActiveInboxHandoffs>){return transportClient.listActiveInboxHandoffs(...parameters)},
  listSupervisedInboxHandoffs(...parameters:Parameters<typeof transportClient.listSupervisedInboxHandoffs>){return transportClient.listSupervisedInboxHandoffs(...parameters)},
  listResolvedInboxHandoffs(...parameters:Parameters<typeof transportClient.listResolvedInboxHandoffs>){return transportClient.listResolvedInboxHandoffs(...parameters)},
  listInboxSlaAlerts(...parameters:Parameters<typeof transportClient.listInboxSlaAlerts>){return transportClient.listInboxSlaAlerts(...parameters)},
  acknowledgeInboxSlaAlert(...parameters:Parameters<typeof transportClient.acknowledgeInboxSlaAlert>){return transportClient.acknowledgeInboxSlaAlert(...parameters)},
  reopenInboxHandoff(...parameters:Parameters<typeof transportClient.reopenInboxHandoff>){return transportClient.reopenInboxHandoff(...parameters)},
  getInboxConversation(...parameters:Parameters<typeof transportClient.getInboxConversation>){return transportClient.getInboxConversation(...parameters)},
  listInboxConversationMessages(...parameters:Parameters<typeof transportClient.listInboxConversationMessages>){return transportClient.listInboxConversationMessages(...parameters)},
  sendHumanTextMessage(...parameters:Parameters<typeof transportClient.sendHumanTextMessage>){return transportClient.sendHumanTextMessage(...parameters)},
  cancelHumanTextMessage(...parameters:Parameters<typeof transportClient.cancelHumanTextMessage>){return transportClient.cancelHumanTextMessage(...parameters)},
};
