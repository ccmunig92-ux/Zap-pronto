import { useEffect, useMemo, useRef, useState } from "react";
import type { CurrentUser } from "@zap-pronto/contracts";
import { ApiProblem, AuthenticationRequired } from "@zap-pronto/api-client";
import { apiClient } from "./api.js";
import { clearAuthSession, isAuthConfigured, signIn, signOut } from "./auth.js";
import { InvitationPanel, type InvitationClient } from "./InvitationPanel.js";
import { AdministrationPanel, type AdministrationClient } from "./AdministrationPanel.js";
import { AcceptInvitationPanel, type AcceptanceClient } from "./AcceptInvitationPanel.js";
import { RoutingRequiredPanel,type RoutingRequiredClient } from "./RoutingRequiredPanel.js";
import { InboxPanel,type InboxClient } from "./InboxPanel.js";
import { UnitMembershipPanel,type UnitMembershipClient } from "./UnitMembershipPanel.js";
import { UnitSlaPolicyPanel,type UnitSlaPolicyClient } from "./UnitSlaPolicyPanel.js";
import{TeamAvailabilityPanel,type TeamAvailabilityClient}from"./TeamAvailabilityPanel.js";
import{UnitOperationalTimezonePanel,type UnitOperationalTimezoneClient}from"./UnitOperationalTimezonePanel.js";
import{StaffSchedulePanel,type StaffScheduleClient}from"./StaffSchedulePanel.js";
import{UnitAssignmentPolicyPanel,type UnitAssignmentPolicyClient}from"./UnitAssignmentPolicyPanel.js";

type SessionState =
  | { status: "loading" }
  | { status: "ready"; currentUser: CurrentUser }
  | { status: "authentication-required" }
  | { status: "error"; message: string; correlationId?: string };

export type NavigationState = { readonly blocked: boolean; readonly dirty: boolean };
type ModuleId = "INBOX" | "TEAM_AVAILABILITY" | "ROUTING" | "TENANT_ACCESS" | "UNIT_MEMBERSHIPS" | "UNIT_SLA_POLICY" | "UNIT_OPERATIONAL_TIMEZONE" | "OVERVIEW";
type PanelId = "inbox" | "routing" | "invitation" | "administration" | "unit-memberships" | "unit-sla-policy" | "unit-assignment-policy" | "unit-operational-timezone" | "unit-shift-schedule";
const emptyNavigationState: NavigationState = { blocked: false, dirty: false };

export interface SessionClient { getCurrentUser(): Promise<CurrentUser> }
export function App({ client = apiClient, invitationClient = apiClient, administrationClient = apiClient,
  unitMembershipClient=apiClient,slaPolicyClient=apiClient,assignmentPolicyClient=apiClient,teamAvailabilityClient=apiClient,operationalTimezoneClient=apiClient,staffScheduleClient,acceptanceClient = apiClient,routingClient=apiClient,inboxClient=apiClient, initialAuthInitializationFailed = false,
  retryAuthInitialization }: {
  readonly client?: SessionClient; readonly invitationClient?: InvitationClient;
  readonly administrationClient?: AdministrationClient;
  readonly unitMembershipClient?:UnitMembershipClient;
  readonly slaPolicyClient?:UnitSlaPolicyClient;
  readonly assignmentPolicyClient?:UnitAssignmentPolicyClient;
  readonly teamAvailabilityClient?:TeamAvailabilityClient;
  readonly operationalTimezoneClient?:UnitOperationalTimezoneClient;
  readonly staffScheduleClient?:StaffScheduleClient;
  readonly acceptanceClient?: AcceptanceClient;
  readonly routingClient?:RoutingRequiredClient;
  readonly inboxClient?:InboxClient;
  readonly initialAuthInitializationFailed?: boolean;
  readonly retryAuthInitialization?: () => Promise<
    { status: "ready" | "error" | "redirecting" | "blocked" }
  >;
}) {
  const [session, setSession] = useState<SessionState>({ status: "loading" });
  const [authInitializationFailed, setAuthInitializationFailed] = useState(initialAuthInitializationFailed);
  const [authRetrying, setAuthRetrying] = useState(false);
  const [loginError, setLoginError] = useState<string>();
  const [logoutError, setLogoutError] = useState<string>();
  const [selectedModule, setSelectedModule] = useState<ModuleId>();
  const [navigationStates, setNavigationStates] = useState<Record<string, NavigationState>>({});
  const moduleContentRef = useRef<HTMLDivElement>(null);
  const scheduleClient=useMemo<StaffScheduleClient>(()=>staffScheduleClient??{
    listShiftMembers:unitId=>apiClient.listShiftMembers(unitId),
    getEffectiveStaffShift:(unitId,userId)=>apiClient.getEffectiveStaffShift(unitId,userId),
    async getStaffSchedule(unitId,userId){const value=await apiClient.getStaffSchedule(unitId,userId);return value?{...value,weeklySlots:[...value.weeklySlots],exceptions:value.exceptions.map(exception=>({date:exception.date,kind:exception.type,slots:exception.type==="REPLACE"?[...exception.slots]:[]}))}:null},
    async setStaffSchedule(unitId,userId,input,key){const value=await apiClient.setStaffSchedule(unitId,userId,{...input,exceptions:input.exceptions.map(exception=>exception.kind==="CLOSED"?{date:exception.date,type:"CLOSED" as const}:{date:exception.date,type:"REPLACE" as const,slots:exception.slots})},key);return{...value,weeklySlots:[...value.weeklySlots],exceptions:value.exceptions.map(exception=>({date:exception.date,kind:exception.type,slots:exception.type==="REPLACE"?[...exception.slots]:[]}))}},
  },[staffScheduleClient]);
  const navigationReporters=useMemo(()=>Object.fromEntries((["inbox","routing","invitation","administration","unit-memberships","unit-sla-policy","unit-assignment-policy","unit-operational-timezone","unit-shift-schedule"] as const)
    .map(panel=>[panel,(state:NavigationState)=>setNavigationStates(current=>{
      const previous=current[panel];if(previous?.blocked===state.blocked&&previous.dirty===state.dirty)return current;
      return {...current,[panel]:state};
    })])) as Record<PanelId,(state:NavigationState)=>void>,[]);
  function invalidateAuthentication(): void {
    setSession({ status: "authentication-required" });
    void clearAuthSession();
  }
  function refreshAuthorization(): void {
    setSession({ status: "loading" });
    client.getCurrentUser().then((currentUser) => setSession({ status: "ready", currentUser })).catch((error: unknown) => {
      if (error instanceof AuthenticationRequired) invalidateAuthentication();
      else setSession({ status: "error", message: "Não foi possível atualizar suas permissões." });
    });
  }
  useEffect(() => {
    if (authInitializationFailed) return;
    let active = true;
    client.getCurrentUser().then((currentUser) => {
      if (active) setSession({ status: "ready", currentUser });
    }).catch((error: unknown) => {
      if (!active) return;
      if (error instanceof AuthenticationRequired) setSession({ status: "authentication-required" });
      else if (error instanceof ApiProblem) setSession({ status: "error", message: error.problem.title,
        correlationId: error.problem.correlationId });
      else setSession({ status: "error", message: "Não foi possível carregar a sessão." });
    });
    return () => { active = false; };
  }, [authInitializationFailed, client]);

  if (authInitializationFailed) return <main><h1>Falha ao iniciar a autenticação</h1>
    <p>Não foi possível concluir o retorno seguro do provedor de identidade.</p>
    <button type="button" disabled={authRetrying || !retryAuthInitialization} onClick={() => {
      if (!retryAuthInitialization) return;
      setAuthRetrying(true);
      void retryAuthInitialization().then((result) => {
        if (result.status === "ready") setAuthInitializationFailed(false);
      }).catch(() => undefined).finally(() => setAuthRetrying(false));
    }}>{authRetrying ? "Tentando novamente…" : "Tentar novamente"}</button></main>;

  if (session.status === "loading") return <main><p>Carregando sessão…</p></main>;
  const configured = isAuthConfigured();
  if (session.status === "authentication-required") return <main><h1>Zap Pronto</h1>
    <p>{configured ? "Autenticação necessária." : "OIDC não configurado neste ambiente."}</p>
    <button type="button" disabled={!configured} onClick={() => {
      void signIn().catch(() => setLoginError("Não foi possível iniciar a autenticação."));
    }}>Entrar</button>{loginError && <p>{loginError}</p>}{logoutError && <p role="alert">{logoutError}</p>}
    {configured && <AcceptInvitationPanel client={acceptanceClient} onAuthenticationRequired={invalidateAuthentication}
      onAccepted={(currentUser) => setSession({ status: "ready", currentUser })}/>}</main>;
  if (session.status === "error") return <main><h1>Falha ao carregar a sessão</h1><p>{session.message}</p>
    {session.correlationId && <small>Correlação: {session.correlationId}</small>}</main>;

  const { currentUser } = session;
  const canManageTenantUsers=currentUser.grants.some(grant=>grant.permission==="tenant.users.manage"&&grant.scope==="TENANT");
  const managedUnits=currentUser.memberships.filter(membership=>currentUser.grants.some(grant=>
    grant.permission==="unit.members.manage"&&grant.scope==="UNIT"&&grant.unitId===membership.unitId))
    .map(membership=>({id:membership.unitId,name:membership.unitName}));
  const canReadTenantSlaPolicy=currentUser.grants.some(grant=>grant.permission==="sla_policy.read"&&grant.scope==="TENANT");
  const canManageTenantSlaPolicy=currentUser.grants.some(grant=>grant.permission==="sla_policy.manage"&&grant.scope==="TENANT");
  const slaPolicyUnits=currentUser.memberships.filter(membership=>canReadTenantSlaPolicy||canManageTenantSlaPolicy||currentUser.grants.some(grant=>
    grant.permission==="sla_policy.read"&&grant.scope==="UNIT"&&grant.unitId===membership.unitId||
    grant.permission==="sla_policy.manage"&&grant.scope==="UNIT"&&grant.unitId===membership.unitId))
    .map(membership=>({id:membership.unitId,name:membership.unitName}));
  const manageableSlaPolicyUnitIds=currentUser.memberships.filter(membership=>canManageTenantSlaPolicy||currentUser.grants.some(grant=>
    grant.permission==="sla_policy.manage"&&grant.scope==="UNIT"&&grant.unitId===membership.unitId)).map(membership=>membership.unitId);
  const inboxUnits=currentUser.memberships.filter(m=>currentUser.grants.some(g=>g.permission==="conversation.read"&&g.scope==="UNIT"&&g.unitId===m.unitId)).map(m=>({id:m.unitId,name:m.unitName}));
  const teamAvailabilityUnits=currentUser.memberships.filter(m=>currentUser.grants.some(g=>g.permission==="availability.supervise"&&(g.scope==="TENANT"||(g.scope==="UNIT"&&g.unitId===m.unitId)))).map(m=>({id:m.unitId,name:m.unitName}));
  const timezoneUnits=currentUser.memberships.filter(m=>currentUser.grants.some(g=>g.permission==="unit_timezone.read"&&(g.scope==="TENANT"||(g.scope==="UNIT"&&g.unitId===m.unitId))||g.permission==="unit_timezone.manage"&&(g.scope==="TENANT"||(g.scope==="UNIT"&&g.unitId===m.unitId)))).map(m=>({id:m.unitId,name:m.unitName}));
  const manageableTimezoneUnitIds=currentUser.memberships.filter(m=>currentUser.grants.some(g=>g.permission==="unit_timezone.manage"&&(g.scope==="TENANT"||(g.scope==="UNIT"&&g.unitId===m.unitId)))).map(m=>m.unitId);
  const shiftUnits=currentUser.memberships.filter(m=>currentUser.grants.some(g=>g.permission==="shift.read"&&(g.scope==="TENANT"||(g.scope==="UNIT"&&g.unitId===m.unitId)))).map(m=>({id:m.unitId,name:m.unitName}));
  const manageableShiftUnitIds=currentUser.memberships.filter(m=>currentUser.grants.some(g=>g.permission==="shift.manage"&&(g.scope==="TENANT"||(g.scope==="UNIT"&&g.unitId===m.unitId)))).map(m=>m.unitId);
  const canReadRouting=currentUser.grants.some(grant=>grant.permission==="inbound.routing.read"&&grant.scope==="TENANT");
  const modules:readonly {id:ModuleId;label:string}[]=[
    ...(inboxUnits.length>0?[{id:"INBOX" as const,label:"Inbox"}]:[]),
    ...(teamAvailabilityUnits.length>0?[{id:"TEAM_AVAILABILITY" as const,label:"Equipe"}]:[]),
    ...(canReadRouting?[{id:"ROUTING" as const,label:"Roteamento"}]:[]),
    ...(canManageTenantUsers?[{id:"TENANT_ACCESS" as const,label:"Acessos"}]:[]),
    ...(!canManageTenantUsers&&managedUnits.length>0?[{id:"UNIT_MEMBERSHIPS" as const,label:"Vínculos"}]:[]),
    ...(slaPolicyUnits.length>0?[{id:"UNIT_SLA_POLICY" as const,label:"Política de SLA"}]:[]),
    ...(timezoneUnits.length>0||shiftUnits.length>0?[{id:"UNIT_OPERATIONAL_TIMEZONE" as const,label:"Escalas"}]:[]),
    {id:"OVERVIEW",label:"Visão geral"},
  ];
  const activeModule=modules.some(module=>module.id===selectedModule)?selectedModule!:modules[0]!.id;
  const activePanels:readonly PanelId[]=activeModule==="INBOX"?["inbox"]:activeModule==="ROUTING"?["routing"]:
    activeModule==="TENANT_ACCESS"?["invitation","administration"]:activeModule==="UNIT_MEMBERSHIPS"?["unit-memberships"]:activeModule==="UNIT_SLA_POLICY"?["unit-sla-policy"]:activeModule==="UNIT_OPERATIONAL_TIMEZONE"?["unit-operational-timezone","unit-shift-schedule","unit-assignment-policy"]:[];
  const activeNavigationState=Object.entries(navigationStates).filter(([key])=>activePanels.includes(key as PanelId))
    .reduce<NavigationState>((state,[,value])=>({blocked:state.blocked||value.blocked,dirty:state.dirty||value.dirty}),emptyNavigationState);
  function navigate(moduleId:ModuleId):void{
    if(moduleId===activeModule||activeNavigationState.blocked)return;
    if(activeNavigationState.dirty&&!window.confirm("Descartar as alterações não salvas deste módulo?"))return;
    setNavigationStates({});setSelectedModule(moduleId);
    queueMicrotask(()=>{const heading=moduleContentRef.current?.querySelector<HTMLElement>("h2");
      if(heading){heading.tabIndex=-1;heading.focus();}});
  }
  return <main>
    <header><div><span>Zap Pronto</span><h1>{currentUser.tenant.name}</h1></div>
      <div><p>{currentUser.user.displayName}<br/><small>{currentUser.user.email}</small></p>
        <button type="button" onClick={() => { setLogoutError(undefined);setNavigationStates({});
          setSession({ status: "authentication-required" });void signOut()
          .catch(() => setLogoutError("Sessão local encerrada; não foi possível concluir o logout no provedor."));
        }}>Sair</button></div></header>
    <nav className="module-navigation" aria-label="Módulos">{modules.map(module=><button type="button" key={module.id}
      aria-current={module.id===activeModule?"page":undefined} disabled={activeNavigationState.blocked&&module.id!==activeModule}
      onClick={()=>navigate(module.id)}>{module.label}</button>)}</nav>
    <div className="module-content" ref={moduleContentRef}>
    {activeModule==="OVERVIEW"&&<section><h2 tabIndex={-1}>Unidades vinculadas</h2><ul>{currentUser.memberships.map((membership) =>
      <li key={membership.unitId}><strong>{membership.unitName}</strong> <span>{membership.role}</span></li>)}</ul></section>}
    {activeModule==="TEAM_AVAILABILITY"&&teamAvailabilityUnits.length>0&&<TeamAvailabilityPanel client={teamAvailabilityClient} authorizedUnits={teamAvailabilityUnits} onAuthenticationRequired={invalidateAuthentication} onAuthorizationChanged={refreshAuthorization}/>}
    {activeModule==="TENANT_ACCESS"&&canManageTenantUsers
      && <><InvitationPanel client={invitationClient} onAuthenticationRequired={invalidateAuthentication}
        onAuthorizationChanged={refreshAuthorization} onNavigationStateChange={navigationReporters.invitation}/>
        <AdministrationPanel client={administrationClient} onAuthenticationRequired={invalidateAuthentication}
          onAuthorizationChanged={refreshAuthorization} onNavigationStateChange={navigationReporters.administration}/></>}
    {activeModule==="UNIT_MEMBERSHIPS"&&!canManageTenantUsers&&managedUnits.length>0&&<UnitMembershipPanel client={unitMembershipClient}
      authorizedUnits={managedUnits} onAuthenticationRequired={invalidateAuthentication}
      onAuthorizationChanged={refreshAuthorization} onNavigationStateChange={navigationReporters["unit-memberships"]}/>}
    {activeModule==="UNIT_SLA_POLICY"&&slaPolicyUnits.length>0&&<UnitSlaPolicyPanel client={slaPolicyClient}
      readableUnits={slaPolicyUnits} manageableUnitIds={manageableSlaPolicyUnitIds} onAuthenticationRequired={invalidateAuthentication}
      onAuthorizationChanged={refreshAuthorization} onNavigationStateChange={navigationReporters["unit-sla-policy"]}/>}
    {activeModule==="UNIT_OPERATIONAL_TIMEZONE"&&timezoneUnits.length>0&&<UnitOperationalTimezonePanel client={operationalTimezoneClient}
      readableUnits={timezoneUnits} manageableUnitIds={manageableTimezoneUnitIds} onAuthenticationRequired={invalidateAuthentication}
      onAuthorizationChanged={refreshAuthorization} onNavigationStateChange={navigationReporters["unit-operational-timezone"]}/>}
    {activeModule==="UNIT_OPERATIONAL_TIMEZONE"&&shiftUnits.length>0&&<StaffSchedulePanel client={scheduleClient} units={shiftUnits}
      manageableUnitIds={manageableShiftUnitIds} onAuthenticationRequired={invalidateAuthentication} onAuthorizationChanged={refreshAuthorization}
      onNavigationStateChange={navigationReporters["unit-shift-schedule"]}/>}
    {activeModule==="UNIT_OPERATIONAL_TIMEZONE"&&shiftUnits.length>0&&<UnitAssignmentPolicyPanel client={assignmentPolicyClient} units={shiftUnits}
      manageableUnitIds={manageableShiftUnitIds} onAuthenticationRequired={invalidateAuthentication} onAuthorizationChanged={refreshAuthorization}
      onNavigationStateChange={navigationReporters["unit-assignment-policy"]}/>}
    {activeModule==="ROUTING"&&canReadRouting&&
      <RoutingRequiredPanel client={routingClient}
        canResolve={currentUser.grants.some(grant=>grant.permission==="inbound.routing.resolve"&&grant.scope==="TENANT")}
        onAuthenticationRequired={invalidateAuthentication} onAuthorizationChanged={refreshAuthorization}
        onNavigationStateChange={navigationReporters.routing}/>}
    {activeModule==="INBOX"&&inboxUnits.length>0&&<InboxPanel client={inboxClient}
      units={inboxUnits}
      supervisedUnitIds={currentUser.memberships.filter(m=>currentUser.grants.some(g=>g.permission==="handoff.takeover"&&(g.scope==="TENANT"||(g.scope==="UNIT"&&g.unitId===m.unitId)))).map(m=>m.unitId)}
      historyUnitIds={currentUser.memberships.filter(m=>currentUser.grants.some(g=>g.permission==="handoff.history.read"&&(g.scope==="TENANT"||(g.scope==="UNIT"&&g.unitId===m.unitId)))).map(m=>m.unitId)}
      slaAlertReadUnitIds={currentUser.memberships.filter(m=>currentUser.grants.some(g=>g.permission==="sla_alert.read"&&(g.scope==="TENANT"||(g.scope==="UNIT"&&g.unitId===m.unitId)))).map(m=>m.unitId)}
      slaAlertAcknowledgeUnitIds={currentUser.memberships.filter(m=>currentUser.grants.some(g=>g.permission==="sla_alert.acknowledge"&&(g.scope==="TENANT"||(g.scope==="UNIT"&&g.unitId===m.unitId)))).map(m=>m.unitId)}
      onAuthenticationRequired={invalidateAuthentication} onAuthorizationChanged={refreshAuthorization}
      onNavigationStateChange={navigationReporters.inbox}/>}
    </div>
  </main>;
}
