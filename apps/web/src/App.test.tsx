// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiProblem, AuthenticationRequired, InvalidApiResponse } from "@zap-pronto/api-client";
import { App } from "./App.js";
import type { AdministrationClient } from "./AdministrationPanel.js";
import type { UnitMembershipClient } from "./UnitMembershipPanel.js";
import type { InboxClient } from "./InboxPanel.js";

function emptyInboxClient(overrides:Partial<InboxClient>={}):InboxClient{return{
  getInboxAvailability:async unitId=>({unitId,userId:"22222222-2222-4222-8222-222222222222",status:"OFFLINE",maxActive:5,pauseReason:null,pausedUntil:null,activeCount:0,version:1,updatedAt:"2026-08-12T20:00:00.000Z"}),
  setInboxAvailability:async input=>({unitId:input.unitId,userId:"22222222-2222-4222-8222-222222222222",status:input.status,maxActive:input.maxActive,pauseReason:input.pauseReason??null,pausedUntil:input.pausedUntil??null,activeCount:0,version:input.expectedVersion+1,updatedAt:"2026-08-12T20:01:00.000Z",replayed:false}),
  listHandoffs:async()=>({items:[]}),claimHandoff:async()=>({}),resolveHandoff:async()=>({}),reopenInboxHandoff:async()=>({}),requeueHandoff:async()=>({}),
  listInboxHandoffTransferCandidates:async()=>({items:[]}),transferInboxHandoff:async()=>({}),takeoverInboxHandoff:async()=>({}),
  listActiveInboxHandoffs:async()=>({items:[]}),listSupervisedInboxHandoffs:async()=>({items:[]}),
  listResolvedInboxHandoffs:async()=>({items:[]}),getInboxConversation:async()=>{throw new Error("not called")},
  listInboxSlaAlerts:async()=>({items:[]}),acknowledgeInboxSlaAlert:async()=>{throw new Error("not called")},
  listInboxConversationMessages:async()=>({items:[]}),sendHumanTextMessage:async()=>({}),cancelHumanTextMessage:async()=>({}),...overrides};}

afterEach(cleanup);
describe("authenticated shell", () => {
  it("mounts the unit membership catalog only for units explicitly authorized to the unit manager", async () => {
    const listUnitMemberships = vi.fn(async () => ({ items: [] }));
    const unitMembershipClient: UnitMembershipClient = {
      listUnitMemberships,
      async changeUnitMembership() { return {}; },
    };
    render(<App client={{ async getCurrentUser() { return {
      user: { id: "22222222-2222-4222-8222-222222222222", email: "manager@example.test", displayName: "Gerente" },
      tenant: { id: "11111111-1111-4111-8111-111111111111", name: "Clínica" },
      memberships: [
        { unitId: "33333333-3333-4333-8333-333333333333", unitCode: "CENTRO", unitName: "Centro", role: "UNIT_MANAGER" as const },
        { unitId: "44444444-4444-4444-8444-444444444444", unitCode: "NORTE", unitName: "Norte", role: "ATTENDANT" as const },
      ],
      grants: [{ permission: "unit.members.manage" as const, scope: "UNIT" as const,
        unitId: "33333333-3333-4333-8333-333333333333" }],
    }; } }} unitMembershipClient={unitMembershipClient}/>);

    expect(await screen.findByRole("heading", { name: "Vínculos da unidade" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Centro" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Norte" })).toBeNull();
    await waitFor(() => expect(listUnitMemberships).toHaveBeenCalledWith({
      unitId: "33333333-3333-4333-8333-333333333333", limit: 25,
    }));
  });
  it("does not call the unit membership catalog without the explicit unit grant", async () => {
    const listUnitMemberships = vi.fn(async () => ({ items: [] }));
    render(<App client={{ async getCurrentUser() { return {
      user: { id: "22222222-2222-4222-8222-222222222222", email: "manager@example.test", displayName: "Gerente" },
      tenant: { id: "11111111-1111-4111-8111-111111111111", name: "Clínica" },
      memberships: [{ unitId: "33333333-3333-4333-8333-333333333333", unitCode: "CENTRO",
        unitName: "Centro", role: "UNIT_MANAGER" as const }], grants: [],
    }; } }} unitMembershipClient={{ listUnitMemberships, async changeUnitMembership() { return {}; } }}/>)
    expect(await screen.findByText("Clínica")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Vínculos da unidade" })).toBeNull();
    expect(listUnitMemberships).not.toHaveBeenCalled();
  });
  it("keeps tenant administration canonical without mounting a duplicate unit catalog", async () => {
    const listUnitMemberships = vi.fn(async () => ({ items: [] }));
    const administrationClient: AdministrationClient = {
      async listAdministrativeUsers() { return { items: [] }; },
      async listAdministrativeInvitations() { return { items: [] }; },
      async changeUnitMembership() { return {}; },
      async changeAdministrativeUserStatus() { return {}; },
      async revokeUserInvitation() { return {}; },
      async reissueUserInvitation():ReturnType<AdministrationClient["reissueUserInvitation"]> {
        throw new Error("not used");
      },
    };
    render(<App client={{ async getCurrentUser() { return {
      user: { id: "22222222-2222-4222-8222-222222222222", email: "admin@example.test", displayName: "Admin" },
      tenant: { id: "11111111-1111-4111-8111-111111111111", name: "Clínica" },
      memberships: [{ unitId: "33333333-3333-4333-8333-333333333333", unitCode: "CENTRO",
        unitName: "Centro", role: "UNIT_MANAGER" as const }],
      grants: [
        { permission: "tenant.users.manage" as const, scope: "TENANT" as const },
        { permission: "unit.members.manage" as const, scope: "UNIT" as const,
          unitId: "33333333-3333-4333-8333-333333333333" },
      ],
    }; } }} administrationClient={administrationClient}
      invitationClient={{ async getUserInvitationOptions() { return { providers: [], units: [], roles: [] }; },
        async createUserInvitation() { throw new Error("not called"); } }}
      unitMembershipClient={{ listUnitMemberships, async changeUnitMembership() { return {}; } }}/>)
    expect(await screen.findByRole("heading", { name: "Administração de acesso" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Vínculos da unidade" })).toBeNull();
    expect(listUnitMemberships).not.toHaveBeenCalled();
  });
  it("mounts routing queue only from explicit tenant grant",async()=>{const listRoutingRequired=vi.fn(async()=>({items:[]}));
    render(<App client={{async getCurrentUser(){return{user:{id:"22222222-2222-4222-8222-222222222222",email:"admin@test",displayName:"Admin"},
      tenant:{id:"11111111-1111-4111-8111-111111111111",name:"Clínica"},memberships:[],
      grants:[{permission:"inbound.routing.read" as const,scope:"TENANT" as const}]}}}}
      routingClient={{listRoutingRequired,async resolveRoutingRequired(){return{replayed:false}}}}/>);
    expect(await screen.findByRole("heading",{name:"Aguardando unidade"})).toBeTruthy();await vi.waitFor(()=>expect(listRoutingRequired).toHaveBeenCalledOnce());});
  it("deriva leitura e reconhecimento de alertas SLA de grants unitários explícitos",async()=>{const unitId="33333333-3333-4333-8333-333333333333",list=vi.fn(async()=>({items:[{handoffId:"10000000-0000-4000-8000-000000000001",unitId,priority:"HIGH"as const,severity:"MISSING_SLA"as const,slaDueAt:null,queuedAt:"2026-08-12T18:00:00.000Z",ageSeconds:600,availableCapacity:2,acknowledgedAt:null,version:1}]}));render(<App client={{async getCurrentUser(){return{user:{id:"22222222-2222-4222-8222-222222222222",email:"supervisor@test",displayName:"Supervisor"},tenant:{id:"11111111-1111-4111-8111-111111111111",name:"Clínica"},memberships:[{unitId,unitCode:"CENTRO",unitName:"Centro",role:"SUPERVISOR"as const}],grants:[{permission:"conversation.read"as const,scope:"UNIT"as const,unitId},{permission:"sla_alert.read"as const,scope:"UNIT"as const,unitId},{permission:"sla_alert.acknowledge"as const,scope:"UNIT"as const,unitId}]}}}} inboxClient={emptyInboxClient({listInboxSlaAlerts:list})}/>);expect(await screen.findByRole("heading",{name:"Alertas de SLA"})).toBeTruthy();expect(screen.getAllByText("Sem prazo de SLA")).toHaveLength(2);expect(screen.getByRole("button",{name:"Reconhecer alerta"})).toBeTruthy();expect(list).toHaveBeenCalledWith({unitId,limit:25})});
  it("mounts only the highest-priority authorized module and starts inactive clients only after navigation",async()=>{
    const listQueue=vi.fn(async()=>({items:[]}));const listActive=vi.fn(async()=>({items:[]}));
    const listRoutingRequired=vi.fn(async()=>({items:[]}));
    render(<App client={{async getCurrentUser(){return{user:{id:"22222222-2222-4222-8222-222222222222",email:"agent@test",displayName:"Agente"},
      tenant:{id:"11111111-1111-4111-8111-111111111111",name:"Clínica"},memberships:[{unitId:"33333333-3333-4333-8333-333333333333",unitCode:"CENTRO",unitName:"Centro",role:"ATTENDANT" as const}],
      grants:[{permission:"conversation.read" as const,scope:"UNIT" as const,unitId:"33333333-3333-4333-8333-333333333333"},{permission:"inbound.routing.read" as const,scope:"TENANT" as const}]}}}}
      inboxClient={emptyInboxClient({listHandoffs:listQueue,listActiveInboxHandoffs:listActive})}
      routingClient={{listRoutingRequired,async resolveRoutingRequired(){return{replayed:false}}}}/>);
    expect(await screen.findByRole("heading",{name:"Inbox"})).toBeTruthy();
    expect(screen.getByRole("button",{name:"Inbox"}).getAttribute("aria-current")).toBe("page");
    await waitFor(()=>{expect(listQueue).toHaveBeenCalledOnce();expect(listActive).toHaveBeenCalledOnce()});expect(listRoutingRequired).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button",{name:"Roteamento"}));
    expect(await screen.findByRole("heading",{name:"Aguardando unidade"})).toBeTruthy();
    await waitFor(()=>expect(listRoutingRequired).toHaveBeenCalledOnce());
  });
  it("fails closed when OIDC initialization fails and recovers only after an explicit retry", async () => {
    const getCurrentUser = vi.fn().mockResolvedValue({
      user: { id: "22222222-2222-4222-8222-222222222222", email: "agent@example.test", displayName: "Agente" },
      tenant: { id: "11111111-1111-4111-8111-111111111111", name: "Clínica" }, memberships: [], grants: [],
    });
    const retryAuthInitialization = vi.fn().mockResolvedValue({ status: "ready" as const });
    render(<App client={{ getCurrentUser }} initialAuthInitializationFailed
      retryAuthInitialization={retryAuthInitialization}/>);
    expect(screen.getByRole("heading", { name: "Falha ao iniciar a autenticação" })).toBeTruthy();
    expect(getCurrentUser).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await waitFor(() => expect(retryAuthInitialization).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Clínica")).toBeTruthy();
    expect(getCurrentUser).toHaveBeenCalledTimes(1);
  });
  it("keeps the API blocked when an explicit OIDC retry also fails", async () => {
    const getCurrentUser = vi.fn();
    const retryAuthInitialization = vi.fn().mockResolvedValue({ status: "error" as const });
    render(<App client={{ getCurrentUser }} initialAuthInitializationFailed
      retryAuthInitialization={retryAuthInitialization}/>);
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await waitFor(() => expect(retryAuthInitialization).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("heading", { name: "Falha ao iniciar a autenticação" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tentar novamente" })).toBeTruthy();
    expect(getCurrentUser).not.toHaveBeenCalled();
  });
  it("renders the server-derived tenant and active memberships", async () => {
    render(<App client={{ async getCurrentUser() { return {
      user: { id: "22222222-2222-4222-8222-222222222222", email: "agent@example.test", displayName: "Agente" },
      tenant: { id: "11111111-1111-4111-8111-111111111111", name: "Clínica" },
      memberships: [{ unitId: "33333333-3333-4333-8333-333333333333", unitCode: "CENTRO",
        unitName: "Centro", role: "ATTENDANT" }], grants: [],
    }; } }} />);
    expect(await screen.findByText("Clínica")).toBeTruthy();
    expect(screen.getByText("Centro")).toBeTruthy();
  });
  it("shows sign-in when no access token is available", async () => {
    render(<App client={{ async getCurrentUser() { throw new AuthenticationRequired(); } }} />);
    const button = await screen.findByRole("button", { name: "Entrar" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("OIDC não configurado neste ambiente.")).toBeTruthy();
  });
  it.each([[403, "Forbidden"], [503, "Service Unavailable"]])(
    "shows API problem %s and its correlation id", async (status, title) => {
      render(<App client={{ async getCurrentUser() { throw new ApiProblem({
        type: "urn:test", title, status, correlationId: "correlation-123",
      }); } }} />);
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.getByText("Correlação: correlation-123")).toBeTruthy();
    },
  );
  it("sanitizes an invalid transport response", async () => {
    render(<App client={{ async getCurrentUser() { throw new InvalidApiResponse(); } }} />);
    expect(await screen.findByText("Não foi possível carregar a sessão.")).toBeTruthy();
  });
  it("removes administrative state after a 403 and reloads grants from the server", async () => {
    const base = {
      user: { id: "22222222-2222-4222-8222-222222222222", email: "admin@example.test", displayName: "Admin" },
      tenant: { id: "11111111-1111-4111-8111-111111111111", name: "Clínica" },
      memberships: [],
    } as const;
    const getCurrentUser = vi.fn()
      .mockResolvedValueOnce({ ...base, grants: [{ permission: "tenant.users.manage" as const, scope: "TENANT" as const }] })
      .mockResolvedValueOnce({ ...base, grants: [] });
    const administrationClient: AdministrationClient = {
      async listAdministrativeUsers() { return { items: [{ id: base.user.id, email: base.user.email,
        displayName: base.user.displayName, status: "ACTIVE", version: 1, memberships: [], allowedActions: ["BLOCK"] }] }; },
      async listAdministrativeInvitations() { return { items: [] }; },
      async changeUnitMembership() { return {}; },
      async changeAdministrativeUserStatus() { throw new ApiProblem({ type: "urn:test", title: "Forbidden",
        status: 403, correlationId: "correlation-403" }); },
      async revokeUserInvitation() { return {}; },
      async reissueUserInvitation() { throw new Error("not called"); },
    };
    render(<App client={{ getCurrentUser }} administrationClient={administrationClient}
      invitationClient={{ async getUserInvitationOptions() { return { providers: [], units: [], roles: [] }; },
        async createUserInvitation() { throw new Error("not called"); } }}/>);
    fireEvent.click(await screen.findByRole("button", { name: "Bloquear" }));
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "Permissão revogada" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar bloquear" }));
    await waitFor(() => expect(getCurrentUser).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Administração de acesso")).toBeNull());
    expect(screen.getByText("Clínica")).toBeTruthy();
    expect(screen.getByRole("button",{name:"Visão geral"}).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("button",{name:"Acessos"})).toBeNull();
  });
  it("ends the local shell session through the canonical logout action", async () => {
    render(<App client={{ async getCurrentUser() { return {
      user: { id: "22222222-2222-4222-8222-222222222222", email: "agent@example.test", displayName: "Agente" },
      tenant: { id: "11111111-1111-4111-8111-111111111111", name: "Clínica" }, memberships: [], grants: [],
    }; } }}/>);
    fireEvent.click(await screen.findByRole("button", { name: "Sair" }));
    expect(await screen.findByRole("button", { name: "Entrar" })).toBeTruthy();
    expect(screen.queryByText("Agente")).toBeNull();
  });
});
