import { useEffect, useState } from "react";
import type { CurrentUser } from "@zap-pronto/contracts";
import { ApiProblem, AuthenticationRequired } from "@zap-pronto/api-client";
import { apiClient } from "./api.js";
import { isAuthConfigured, signIn } from "./auth.js";

type SessionState =
  | { status: "loading" }
  | { status: "ready"; currentUser: CurrentUser }
  | { status: "authentication-required" }
  | { status: "error"; message: string; correlationId?: string };

export interface SessionClient { getCurrentUser(): Promise<CurrentUser> }
export function App({ client = apiClient }: { readonly client?: SessionClient }) {
  const [session, setSession] = useState<SessionState>({ status: "loading" });
  const [loginError, setLoginError] = useState<string>();
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
  if (session.status === "authentication-required") return <main><h1>Zap Pronto</h1>
    <p>{isAuthConfigured() ? "Autenticação necessária." : "OIDC não configurado neste ambiente."}</p>
    <button type="button" disabled={!isAuthConfigured()} onClick={() => {
      void signIn().catch(() => setLoginError("Não foi possível iniciar a autenticação."));
    }}>Entrar</button>{loginError && <p>{loginError}</p>}</main>;
  if (session.status === "error") return <main><h1>Falha ao carregar a sessão</h1><p>{session.message}</p>
    {session.correlationId && <small>Correlação: {session.correlationId}</small>}</main>;

  const { currentUser } = session;
  return <main>
    <header><div><span>Zap Pronto</span><h1>{currentUser.tenant.name}</h1></div>
      <p>{currentUser.user.displayName}<br/><small>{currentUser.user.email}</small></p></header>
    <section><h2>Unidades vinculadas</h2><ul>{currentUser.memberships.map((membership) =>
      <li key={membership.unitId}><strong>{membership.unitName}</strong> <span>{membership.role}</span></li>)}</ul></section>
  </main>;
}
