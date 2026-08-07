import { useEffect, useState } from "react";
import { ApiProblem, AuthenticationRequired } from "@zap-pronto/api-client";
import type {
  AdministrativeInvitation, AdministrativeInvitationsPage, AdministrativeUser, AdministrativeUsersPage,
  ChangeUserStatusRequest, ReissueInvitationRequest, ReissueInvitationResponse, RevokeInvitationRequest,
} from "@zap-pronto/contracts";

export interface AdministrationClient {
  listAdministrativeUsers(input?: { limit?: number; cursor?: string }): Promise<AdministrativeUsersPage>;
  listAdministrativeInvitations(input?: { limit?: number; cursor?: string }): Promise<AdministrativeInvitationsPage>;
  changeAdministrativeUserStatus(userId: string, input: ChangeUserStatusRequest, key: string): Promise<unknown>;
  revokeUserInvitation(invitationId: string, input: RevokeInvitationRequest, key: string): Promise<unknown>;
  reissueUserInvitation(invitationId: string, input: ReissueInvitationRequest, key: string): Promise<ReissueInvitationResponse>;
}

type PendingAction =
  | { kind: "USER"; item: AdministrativeUser; action: ChangeUserStatusRequest["action"] }
  | { kind: "INVITATION"; item: AdministrativeInvitation; action: "REVOKE" | "REISSUE" };

const actionLabels = { BLOCK: "Bloquear", ACTIVATE: "Reativar", REVOKE: "Revogar", REISSUE: "Reemitir" } as const;
function tomorrow(): string {
  const value = new Date(Date.now() + 24 * 60 * 60 * 1000);
  value.setMinutes(value.getMinutes() - value.getTimezoneOffset());
  return value.toISOString().slice(0, 16);
}

export function AdministrationPanel({ client, onAuthenticationRequired = () => undefined,
  onAuthorizationChanged = () => undefined }: { readonly client: AdministrationClient;
  readonly onAuthenticationRequired?: () => void; readonly onAuthorizationChanged?: () => void }) {
  const [users, setUsers] = useState<AdministrativeUser[]>([]);
  const [invitations, setInvitations] = useState<AdministrativeInvitation[]>([]);
  const [userCursor, setUserCursor] = useState<string>();
  const [invitationCursor, setInvitationCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string>();
  const [pending, setPending] = useState<PendingAction>();
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState(tomorrow);
  const [mutationKey, setMutationKey] = useState<string>();
  const [mutationError, setMutationError] = useState<{ message: string; correlationId?: string }>();
  const [submitting, setSubmitting] = useState(false);
  const [delivery, setDelivery] = useState<ReissueInvitationResponse>();
  const [revealed, setRevealed] = useState(false);

  async function loadInitial(): Promise<void> {
    setLoading(true); setPageError(undefined);
    try {
      const [userPage, invitationPage] = await Promise.all([
        client.listAdministrativeUsers({ limit: 25 }), client.listAdministrativeInvitations({ limit: 25 }),
      ]);
      setUsers(userPage.items); setUserCursor(userPage.nextCursor);
      setInvitations(invitationPage.items); setInvitationCursor(invitationPage.nextCursor);
    } catch (cause) {
      if (cause instanceof AuthenticationRequired) onAuthenticationRequired();
      else if (cause instanceof ApiProblem && cause.problem.status === 403) onAuthorizationChanged();
      else setPageError("Não foi possível carregar usuários e convites.");
    }
    finally { setLoading(false); }
  }
  useEffect(() => { void loadInitial(); }, [client]);

  function openAction(value: PendingAction): void {
    setPending(value); setReason(""); setExpiresAt(tomorrow()); setMutationKey(undefined); setMutationError(undefined);
  }
  function closeAction(): void {
    if (submitting) return;
    setPending(undefined); setReason(""); setMutationKey(undefined); setMutationError(undefined);
  }
  async function confirmAction(): Promise<void> {
    if (!pending || reason.trim().length < 3) return;
    const key = mutationKey ?? crypto.randomUUID(); setMutationKey(key); setSubmitting(true); setMutationError(undefined);
    try {
      if (pending.kind === "USER") {
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
        setDelivery(response);
      }
      setPending(undefined); setMutationKey(undefined); await loadInitial();
    } catch (error) {
      if (error instanceof AuthenticationRequired) onAuthenticationRequired();
      else if (error instanceof ApiProblem && error.problem.status === 403) onAuthorizationChanged();
      else if (error instanceof ApiProblem) setMutationError({ message: error.problem.title,
        correlationId: error.problem.correlationId });
      else setMutationError({ message: "Não foi possível concluir a ação." });
    } finally { setSubmitting(false); }
  }
  async function loadMoreUsers(): Promise<void> {
    if (!userCursor) return;
    try {
      const page = await client.listAdministrativeUsers({ limit: 25, cursor: userCursor });
      setUsers((items) => [...items, ...page.items]); setUserCursor(page.nextCursor);
    } catch (cause) {
      if (cause instanceof AuthenticationRequired) onAuthenticationRequired();
      else if (cause instanceof ApiProblem && cause.problem.status === 403) onAuthorizationChanged();
      else setPageError("Não foi possível carregar mais usuários.");
    }
  }
  async function loadMoreInvitations(): Promise<void> {
    if (!invitationCursor) return;
    try {
      const page = await client.listAdministrativeInvitations({ limit: 25, cursor: invitationCursor });
      setInvitations((items) => [...items, ...page.items]); setInvitationCursor(page.nextCursor);
    } catch (cause) {
      if (cause instanceof AuthenticationRequired) onAuthenticationRequired();
      else if (cause instanceof ApiProblem && cause.problem.status === 403) onAuthorizationChanged();
      else setPageError("Não foi possível carregar mais convites.");
    }
  }

  if (loading) return <section><h2>Administração de acesso</h2><p>Carregando…</p></section>;
  if (pageError) return <section><h2>Administração de acesso</h2><p role="alert">{pageError}</p>
    <button type="button" onClick={() => void loadInitial()}>Tentar novamente</button></section>;

  return <section aria-labelledby="administration-title"><h2 id="administration-title">Administração de acesso</h2>
    <h3>Usuários</h3>{users.length === 0 ? <p>Nenhum usuário encontrado.</p> : <ul>{users.map((user) =>
      <li key={user.id}><div><strong>{user.displayName}</strong><br/><small>{user.email} · {user.status}</small></div>
        <div className="actions">{user.allowedActions.map((action) => <button type="button" key={action}
          onClick={() => openAction({ kind: "USER", item: user, action })}>{actionLabels[action]}</button>)}</div></li>)}</ul>}
    {userCursor && <button type="button" onClick={() => void loadMoreUsers()}>Carregar mais usuários</button>}

    <h3>Convites</h3>{invitations.length === 0 ? <p>Nenhum convite encontrado.</p> : <ul>{invitations.map((invitation) =>
      <li key={invitation.id}><div><strong>{invitation.displayName}</strong><br/>
        <small>{invitation.email} · {invitation.status}</small></div><div className="actions">
        {invitation.allowedActions.map((action) => <button type="button" key={action}
          onClick={() => openAction({ kind: "INVITATION", item: invitation, action })}>{actionLabels[action]}</button>)}</div></li>)}</ul>}
    {invitationCursor && <button type="button" onClick={() => void loadMoreInvitations()}>Carregar mais convites</button>}

    {pending && <div role="dialog" aria-modal="true" aria-labelledby="action-title" className="delivery-dialog">
      <h3 id="action-title">Confirmar {actionLabels[pending.action].toLowerCase()}</h3>
      <p>Alvo: <strong>{pending.item.displayName}</strong> ({pending.item.email}).</p>
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
        {submitting ? "Processando…" : `Confirmar ${actionLabels[pending.action].toLowerCase()}`}</button>
      <button type="button" disabled={submitting} onClick={closeAction}>Cancelar</button>
    </div>}

    {delivery && <div role="dialog" aria-modal="true" aria-labelledby="reissue-title" className="delivery-dialog">
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
