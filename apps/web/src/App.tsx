import { useEffect, useState } from "react";
import type { CurrentUser } from "@zap-pronto/contracts";
import { ApiProblem, AuthenticationRequired } from "@zap-pronto/api-client";
import { apiClient } from "./api.js";
import { clearAuthSession, isAuthConfigured, signIn, signOut } from "./auth.js";
import { InvitationPanel, type InvitationClient } from "./InvitationPanel.js";
import { AdministrationPanel, type AdministrationClient } from "./AdministrationPanel.js";
import { AcceptInvitationPanel, type AcceptanceClient } from "./AcceptInvitationPanel.js";

type SessionState =
  | { status: "loading" }
  | { status: "ready"; currentUser: CurrentUser }
  | { status: "authentication-required" }
  | { status: "error"; message: string; correlationId?: string };

export interface SessionClient { getCurrentUser(): Promise<CurrentUser> }
export function App({ client = apiClient, invitationClient = apiClient, administrationClient = apiClient,
  acceptanceClient = apiClient }: {
  readonly client?: SessionClient; readonly invitationClient?: InvitationClient;
  readonly administrationClient?: AdministrationClient;
  readonly acceptanceClient?: AcceptanceClient;
}) {
  const [session, setSession] = useState<SessionState>({ status: "loading" });
  const [loginError, setLoginError] = useState<string>();
  const [logoutError, setLogoutError] = useState<string>();
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
  }, [client]);

  if (session.status === "loading") return <main><p>Carregando sessão…</p></main>;
  const configured = isAuthConfigured();
  if (session.status === "authentication-required") return <main><h1>Zap Pronto</h1>
    <p>{configured ? "Autenticação necessária." : "OIDC não configurado neste ambiente."}</p>
    <button type="button" disabled={!configured} onClick={() => {
      void signIn().catch(() => setLoginError("Não foi possível iniciar a autenticação."));
    }}>Entrar</button>{loginError && <p>{loginError}</p>}
    {configured && <AcceptInvitationPanel client={acceptanceClient} onAuthenticationRequired={invalidateAuthentication}
      onAccepted={(currentUser) => setSession({ status: "ready", currentUser })}/>}</main>;
  if (session.status === "error") return <main><h1>Falha ao carregar a sessão</h1><p>{session.message}</p>
    {session.correlationId && <small>Correlação: {session.correlationId}</small>}</main>;

  const { currentUser } = session;
  return <main>
    <header><div><span>Zap Pronto</span><h1>{currentUser.tenant.name}</h1></div>
      <div><p>{currentUser.user.displayName}<br/><small>{currentUser.user.email}</small></p>
        <button type="button" onClick={() => { setLogoutError(undefined); void signOut()
          .then(() => setSession({ status: "authentication-required" }))
          .catch(() => { setSession({ status: "authentication-required" });
            setLogoutError("Sessão local encerrada; não foi possível concluir o logout no provedor."); });
        }}>Sair</button></div></header>
    {logoutError && <p role="alert">{logoutError}</p>}
    <section><h2>Unidades vinculadas</h2><ul>{currentUser.memberships.map((membership) =>
      <li key={membership.unitId}><strong>{membership.unitName}</strong> <span>{membership.role}</span></li>)}</ul></section>
    {currentUser.grants.some((grant) => grant.permission === "tenant.users.manage" && grant.scope === "TENANT")
      && <><InvitationPanel client={invitationClient} onAuthenticationRequired={invalidateAuthentication}
        onAuthorizationChanged={refreshAuthorization}/>
        <AdministrationPanel client={administrationClient} onAuthenticationRequired={invalidateAuthentication}
          onAuthorizationChanged={refreshAuthorization}/></>}
  </main>;
}
