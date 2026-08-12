import { useEffect, useRef, useState } from "react";
import { ApiProblem, AuthenticationRequired } from "@zap-pronto/api-client";
import type {
  AdministrativeInvitation, AdministrativeInvitationsPage, AdministrativeUser, AdministrativeUsersPage,
  ChangeUserStatusRequest,ChangeUnitMembershipRequest, ReissueInvitationRequest, ReissueInvitationResponse, RevokeInvitationRequest,
} from "@zap-pronto/contracts";

export interface AdministrationClient {
  listAdministrativeUsers(input?: { limit?: number; cursor?: string }): Promise<AdministrativeUsersPage>;
  listAdministrativeInvitations(input?: { limit?: number; cursor?: string }): Promise<AdministrativeInvitationsPage>;
  changeAdministrativeUserStatus(userId: string, input: ChangeUserStatusRequest, key: string): Promise<unknown>;
  changeUnitMembership(userId:string,unitId:string,input:ChangeUnitMembershipRequest,key:string):Promise<unknown>;
  revokeUserInvitation(invitationId: string, input: RevokeInvitationRequest, key: string): Promise<unknown>;
  reissueUserInvitation(invitationId: string, input: ReissueInvitationRequest, key: string): Promise<ReissueInvitationResponse>;
}

type PendingAction =
  | { kind: "USER"; item: AdministrativeUser; action: ChangeUserStatusRequest["action"] }
  | {kind:"MEMBERSHIP";user:AdministrativeUser;item:AdministrativeUser["memberships"][number];action:ChangeUnitMembershipRequest["operation"]}
  | { kind: "INVITATION"; item: AdministrativeInvitation; action: "REVOKE" | "REISSUE" };

const actionLabels = { BLOCK: "Bloquear", ACTIVATE: "Reativar", REVOKE: "Revogar", REISSUE: "Reemitir" } as const;
const membershipActionLabels={REVOKE:"Revogar vínculo",REACTIVATE:"Reativar vínculo"}as const;
function tomorrow(): string {
  const value = new Date(Date.now() + 24 * 60 * 60 * 1000);
  value.setMinutes(value.getMinutes() - value.getTimezoneOffset());
  return value.toISOString().slice(0, 16);
}

export function AdministrationPanel({ client, onAuthenticationRequired = () => undefined,
  onAuthorizationChanged = () => undefined, onNavigationStateChange }: { readonly client: AdministrationClient;
  readonly onAuthenticationRequired?: () => void; readonly onAuthorizationChanged?: () => void;
  readonly onNavigationStateChange?: (state: { blocked: boolean; dirty: boolean }) => void }) {
  const [users, setUsers] = useState<AdministrativeUser[]>([]);
  const [invitations, setInvitations] = useState<AdministrativeInvitation[]>([]);
  const [userCursor, setUserCursor] = useState<string>();
  const [invitationCursor, setInvitationCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string>();
  const [userPageError, setUserPageError] = useState<string>();
  const [invitationPageError, setInvitationPageError] = useState<string>();
  const [pending, setPending] = useState<PendingAction>();
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState(tomorrow);
  const [mutationKey, setMutationKey] = useState<string>();
  const [mutationError, setMutationError] = useState<{ message: string; correlationId?: string }>();
  const [submitting, setSubmitting] = useState(false);
  const [delivery, setDelivery] = useState<ReissueInvitationResponse>();
  const [revealed, setRevealed] = useState(false);
  const mutationLock=useRef<symbol|undefined>(undefined);const generation=useRef(0);const userPageFlight=useRef(false);const invitationPageFlight=useRef(false);
  const actionDialogRef=useRef<HTMLDivElement>(null);const deliveryDialogRef=useRef<HTMLDivElement>(null);const openerRef=useRef<HTMLElement|null>(null);

  function purgeSensitive():void{generation.current+=1;setUsers([]);setInvitations([]);setUserCursor(undefined);setInvitationCursor(undefined);setPending(undefined);setReason("");setMutationKey(undefined);setMutationError(undefined);setDelivery(undefined);setRevealed(false);setPageError(undefined);setUserPageError(undefined);setInvitationPageError(undefined);setLoading(false);setSubmitting(false);mutationLock.current=undefined;userPageFlight.current=false;invitationPageFlight.current=false}
  function authFailure(cause:unknown):boolean{if(cause instanceof AuthenticationRequired||cause instanceof ApiProblem&&cause.problem.status===401){purgeSensitive();onAuthenticationRequired();return true}if(cause instanceof ApiProblem&&cause.problem.status===403){purgeSensitive();onAuthorizationChanged();return true}return false}

  async function loadInitial(): Promise<void> {
    const g=++generation.current;userPageFlight.current=false;invitationPageFlight.current=false;setLoading(true); setPageError(undefined);setUserPageError(undefined);setInvitationPageError(undefined);
    try {
      const [userPage, invitationPage] = await Promise.all([
        client.listAdministrativeUsers({ limit: 25 }), client.listAdministrativeInvitations({ limit: 25 }),
      ]);
      if(g!==generation.current)return;setUsers(userPage.items); setUserCursor(userPage.nextCursor);
      setInvitations(invitationPage.items); setInvitationCursor(invitationPage.nextCursor);
    } catch (cause) {
      if(g!==generation.current)return;
      if(authFailure(cause))return;
      else setPageError("Não foi possível carregar usuários e convites.");
    }
    finally { if(g===generation.current)setLoading(false); }
  }
  useEffect(() => { void loadInitial(); return()=>{generation.current+=1}; }, [client]);

  const dialogOpen=Boolean(pending||delivery);
  const navigationBlocked=submitting||dialogOpen;
  const navigationDirty=navigationBlocked||reason.length>0||Boolean(mutationKey)||revealed;
  useEffect(()=>{onNavigationStateChange?.({blocked:navigationBlocked,dirty:navigationDirty})},[onNavigationStateChange,navigationBlocked,navigationDirty]);
  useEffect(()=>()=>onNavigationStateChange?.({blocked:false,dirty:false}),[onNavigationStateChange]);
  useEffect(()=>{
    if(!dialogOpen)return;
    const dialog=pending?actionDialogRef.current:deliveryDialogRef.current;
    const focusTarget=dialog?.querySelector<HTMLElement>("textarea, input, button:not([disabled])");
    focusTarget?.focus();
    function onKeyDown(event:KeyboardEvent):void{
      if(event.key!=="Escape")return;
      event.preventDefault();
      if(pending){if(!submitting)closeAction()}else{setDelivery(undefined);setRevealed(false)}
    }
    document.addEventListener("keydown",onKeyDown);
    return()=>document.removeEventListener("keydown",onKeyDown);
  },[dialogOpen,pending,submitting]);
  useEffect(()=>{if(!dialogOpen&&openerRef.current){openerRef.current.focus();openerRef.current=null}},[dialogOpen]);

  function openAction(value: PendingAction): void {
    openerRef.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
    setPending(value); setReason(""); setExpiresAt(tomorrow()); setMutationKey(undefined); setMutationError(undefined);
  }
  function closeAction(): void {
    if (submitting) return;
    setPending(undefined); setReason(""); setMutationKey(undefined); setMutationError(undefined);
  }
  async function confirmAction(): Promise<void> {
    if (!pending || reason.trim().length < 3) return;
    if(mutationLock.current)return;const token=Symbol("administration-mutation");mutationLock.current=token;
    const g=generation.current;const key = mutationKey ?? crypto.randomUUID(); setMutationKey(key); setSubmitting(true); setMutationError(undefined);
    try {
      if(pending.kind==="MEMBERSHIP")await client.changeUnitMembership(pending.user.id,pending.item.unitId,{operation:pending.action,expectedVersion:pending.item.version,reason:reason.trim()},key);
      else if (pending.kind === "USER") {
        await client.changeAdministrativeUserStatus(pending.item.id,
          { action: pending.action, expectedVersion: pending.item.version, reason: reason.trim() }, key);
      } else if (pending.action === "REVOKE") {
        await client.revokeUserInvitation(pending.item.id, { reason: reason.trim() }, key);
      } else {
        const expiry = new Date(expiresAt);
        if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) {
          setMutationError({ message: "Informe uma data futura válida para expiração." }); return;
        }
        const response = await client.reissueUserInvitation(pending.item.id,
          { reason: reason.trim(), expiresAt: expiry.toISOString() }, key);
        if(g!==generation.current)return;setDelivery(response);
      }
      if(g!==generation.current)return;
      setPending(undefined); setMutationKey(undefined);setSubmitting(false); await loadInitial();
    } catch (error) {
      if(g!==generation.current)return;
      if(authFailure(error))return;
      else if (error instanceof ApiProblem) setMutationError({ message:error.problem.status===409?"Os dados foram alterados. Atualize e tente novamente.":error.problem.status===404?"O vínculo não está mais disponível.":"Não foi possível concluir a ação.",correlationId: error.problem.correlationId });
      else setMutationError({ message: "Não foi possível concluir a ação." });
    } finally {if(mutationLock.current===token)mutationLock.current=undefined;if(g===generation.current)setSubmitting(false); }
  }
  async function loadMoreUsers(): Promise<void> {
    if (!userCursor||userPageFlight.current||mutationLock.current) return;userPageFlight.current=true;const g=generation.current;setUserPageError(undefined);
    try {
      const page = await client.listAdministrativeUsers({ limit: 25, cursor: userCursor });
      if(g!==generation.current)return;setUsers((items) => [...new Map([...items,...page.items].map(item=>[item.id,item])).values()]); setUserCursor(page.nextCursor);
    } catch (cause) {
      if(g!==generation.current)return;
      if(authFailure(cause))return;
      else setUserPageError("Não foi possível carregar mais usuários.");
    }finally{if(g===generation.current)userPageFlight.current=false}
  }
  async function loadMoreInvitations(): Promise<void> {
    if (!invitationCursor||invitationPageFlight.current||mutationLock.current) return;invitationPageFlight.current=true;const g=generation.current;setInvitationPageError(undefined);
    try {
      const page = await client.listAdministrativeInvitations({ limit: 25, cursor: invitationCursor });
      if(g!==generation.current)return;setInvitations((items) => [...new Map([...items,...page.items].map(item=>[item.id,item])).values()]); setInvitationCursor(page.nextCursor);
    } catch (cause) {
      if(g!==generation.current)return;
      if(authFailure(cause))return;
      else setInvitationPageError("Não foi possível carregar mais convites.");
    }finally{if(g===generation.current)invitationPageFlight.current=false}
  }

  if (loading) return <section><h2>Administração de acesso</h2><p>Carregando…</p></section>;
  if (pageError) return <section><h2>Administração de acesso</h2><p role="alert">{pageError}</p>
    <button type="button" onClick={() => void loadInitial()}>Tentar novamente</button></section>;

  return <section aria-labelledby="administration-title"><div inert={dialogOpen?true:undefined} aria-hidden={dialogOpen?true:undefined}><h2 id="administration-title">Administração de acesso</h2>
    <h3>Usuários</h3>{users.length === 0 ? <p>Nenhum usuário encontrado.</p> : <ul>{users.map((user) =>
      <li key={user.id}><div><strong>{user.displayName}</strong><br/><small>{user.email} · {user.status}</small><ul aria-label={`Vínculos de ${user.displayName}`}>{user.memberships.map(membership=><li key={membership.unitId}><span>{membership.unitName} · {membership.role} · {membership.status==="ACTIVE"?"Ativo":"Revogado"}</span>{membership.allowedActions.map(action=><button type="button" key={action} onClick={()=>openAction({kind:"MEMBERSHIP",user,item:membership,action})}>{membershipActionLabels[action]}</button>)}</li>)}</ul></div>
        <div className="actions">{user.allowedActions.map((action) => <button type="button" key={action}
          onClick={() => openAction({ kind: "USER", item: user, action })}>{actionLabels[action]}</button>)}</div></li>)}</ul>}
    {userCursor && <button type="button" onClick={() => void loadMoreUsers()}>Carregar mais usuários</button>}
    {userPageError && <p role="alert">{userPageError} <button type="button" onClick={() => void loadMoreUsers()}>Tentar novamente</button></p>}

    <h3>Convites</h3>{invitations.length === 0 ? <p>Nenhum convite encontrado.</p> : <ul>{invitations.map((invitation) =>
      <li key={invitation.id}><div><strong>{invitation.displayName}</strong><br/>
        <small>{invitation.email} · {invitation.status}</small></div><div className="actions">
        {invitation.allowedActions.map((action) => <button type="button" key={action}
          onClick={() => openAction({ kind: "INVITATION", item: invitation, action })}>{actionLabels[action]}</button>)}</div></li>)}</ul>}
    {invitationCursor && <button type="button" onClick={() => void loadMoreInvitations()}>Carregar mais convites</button>}
    {invitationPageError && <p role="alert">{invitationPageError} <button type="button" onClick={() => void loadMoreInvitations()}>Tentar novamente</button></p>}
    </div>

    {pending && <div ref={actionDialogRef} role="dialog" aria-modal="true" aria-labelledby="action-title" className="delivery-dialog">
      <h3 id="action-title">Confirmar {pending.kind==="MEMBERSHIP"?membershipActionLabels[pending.action].toLowerCase():actionLabels[pending.action].toLowerCase()}</h3>
      <p>Alvo: <strong>{pending.kind==="MEMBERSHIP"?pending.user.displayName:pending.item.displayName}</strong>{pending.kind==="MEMBERSHIP"?` · ${pending.item.unitName}`:` (${pending.item.email}).`}</p>
      {pending.kind === "USER" && pending.action === "REVOKE" &&
        <p role="alert">A revogação da conta é permanente e encerra todas as identidades ativas.</p>}
      {pending.kind === "INVITATION" && pending.action === "REISSUE" && <label>Nova expiração
        <input type="datetime-local" required value={expiresAt} onChange={(event) => {
          setExpiresAt(event.target.value); setMutationKey(undefined); setMutationError(undefined);
        }}/></label>}
      <label>Motivo<textarea required minLength={3} maxLength={500} value={reason} onChange={(event) => {
        setReason(event.target.value); setMutationKey(undefined); setMutationError(undefined);
      }}/></label>
      {mutationError && <p role="alert">{mutationError.message}{mutationError.correlationId &&
        <small> Correlação: {mutationError.correlationId}</small>}</p>}
      <button type="button" disabled={submitting || reason.trim().length < 3} onClick={() => void confirmAction()}>
        {submitting ? "Processando…" : `Confirmar ${pending.kind==="MEMBERSHIP"?membershipActionLabels[pending.action].toLowerCase():actionLabels[pending.action].toLowerCase()}`}</button>
      <button type="button" disabled={submitting} onClick={closeAction}>Cancelar</button>
    </div>}

    {delivery && <div ref={deliveryDialogRef} role="dialog" aria-modal="true" aria-labelledby="reissue-title" className="delivery-dialog">
      <h3 id="reissue-title">Entrega manual do novo convite</h3>
      {delivery.replayed ? <p role="alert">A reemissão já havia sido processada. O token não pode ser exibido novamente.</p>
        : <><p>Copie agora. O token será apagado ao fechar.</p><output aria-label="Novo token do convite">
          {revealed ? delivery.invitationToken : "••••••••••••••••"}</output>
          <button type="button" onClick={() => setRevealed((value) => !value)}>{revealed ? "Ocultar" : "Revelar"}</button>
          <button type="button" onClick={() => { void navigator.clipboard.writeText(delivery.invitationToken); }}>
            Copiar token</button></>}
      <button type="button" onClick={() => { setDelivery(undefined); setRevealed(false); }}>Fechar e apagar token</button>
    </div>}
  </section>;
}
