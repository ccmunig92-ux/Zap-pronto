import { useEffect, useState } from "react";
import type { ChannelConnectionsPage } from "@zap-pronto/contracts";
import { ApiProblem, AuthenticationRequired } from "@zap-pronto/api-client";
import type { NavigationState } from "./App.js";

/**
 * Canonical integration entry point. This panel intentionally does not collect
 * access tokens or pretend to connect Meta before the administrative API exists.
 * The OAuth/Embedded Signup flow must be completed server-side and return only
 * non-secret connection metadata to this view.
 */
export interface ConnectionsPanelProps {
  readonly canManage: boolean;
  readonly client?: { listChannelConnections(): Promise<ChannelConnectionsPage> };
  readonly onAuthenticationRequired?: () => void;
  readonly onAuthorizationChanged?: () => void;
  readonly onNavigationStateChange?: (state: NavigationState) => void;
}

export function ConnectionsPanel({ canManage, client, onAuthenticationRequired, onAuthorizationChanged, onNavigationStateChange }: ConnectionsPanelProps) {
  const [page, setPage] = useState<ChannelConnectionsPage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  useEffect(() => { onNavigationStateChange?.({ blocked: false, dirty: false }); }, [onNavigationStateChange]);
  useEffect(() => {
    if (!client) { setLoading(false); return; }
    let active = true;
    setLoading(true); setError(undefined);
    client.listChannelConnections().then(next => {
      if (active) setPage(next);
    }).catch((cause: unknown) => {
      if (!active) return;
      if (cause instanceof AuthenticationRequired || cause instanceof ApiProblem && cause.problem.status === 401) {
        onAuthenticationRequired?.(); return;
      }
      if (cause instanceof ApiProblem && cause.problem.status === 403) {
        onAuthorizationChanged?.(); setError("Você não tem permissão para consultar os canais deste tenant."); return;
      }
      setError("Não foi possível carregar as conexões de canais.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, onAuthenticationRequired, onAuthorizationChanged]);

  const connections = page?.items ?? [];

  return <section className="connections-panel" aria-labelledby="connections-heading">
    <div className="panel-heading">
      <div>
        <p className="eyebrow">Integrações corporativas</p>
        <h2 id="connections-heading" tabIndex={-1}>Canais e integrações</h2>
      </div>
      <span className="connection-status connection-status-pending" role="status">{loading ? "Carregando…" : connections.length ? "Conexão cadastrada" : "Configuração pendente"}</span>
    </div>
    <p>Conecte o WhatsApp Cloud API da organização para receber mensagens e enviar respostas pela Inbox.</p>
    {!canManage && <p role="status">Somente administradores do tenant podem configurar canais.</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && !error && connections.length === 0 && <>
      <p role="status">Nenhuma conexão WhatsApp foi cadastrada neste tenant.</p>
      <article className="connection-card">
        <div className="connection-card-title"><div><h3>WhatsApp Cloud API</h3><p className="muted">Ainda não conectado.</p></div><span className="connection-badge">Não conectado</span></div>
        <div className="connection-actions">
          <button type="button" disabled title="Disponível quando a API administrativa de conexões for publicada">Conectar com Meta</button>
          <button type="button" disabled title="O QR Code não autentica uma conexão Cloud API">Abrir conversa de teste</button>
        </div>
      </article>
    </>}
    {!loading && !error && connections.map(connection => <article className="connection-card" key={connection.id}>
      <div className="connection-card-title">
        <div>
          <h3>WhatsApp Cloud API</h3>
          <p className="muted">{connection.displayName ?? "Conexão corporativa"} — pode atender mais de uma unidade.</p>
        </div>
        <span className="connection-badge">{connection.status}</span>
      </div>
      <dl className="connection-metadata">
        <div><dt>WABA</dt><dd>{connection.wabaId || "Não informado"}</dd></div>
        <div><dt>Phone Number ID</dt><dd>{connection.phoneNumberId}</dd></div>
        <div><dt>Escopo</dt><dd>{connection.scope}</dd></div>
        <div><dt>Secret</dt><dd>{connection.secretConfigured ? "Configurado no servidor" : "Não configurado"}</dd></div>
      </dl>
      <div className="connection-actions">
        <button type="button" disabled title="Disponível quando a API administrativa de conexões for publicada">
          Conectar com Meta
        </button>
        <button type="button" disabled title="O QR Code não autentica uma conexão Cloud API">
          Abrir conversa de teste
        </button>
      </div>
      <p className="connection-note">
        A conexão oficial usa OAuth/Embedded Signup da Meta. Tokens são mantidos no servidor/secret manager;
        nunca são exibidos ou armazenados neste navegador. QR Code é apenas um atalho para conversa de teste,
        não um método de autenticação.
      </p>
    </article>)}
    <aside className="connection-prerequisites" aria-label="Pré-requisitos da conexão">
      <strong>Pré-requisitos do ambiente</strong>
      <ul>
        <li>WABA e número aprovados no Meta Business.</li>
        <li>Webhook HTTPS exclusivo para este tenant.</li>
        <li>Secret de acesso provisionado no worker.</li>
        <li>Templates aprovados para mensagens fora da janela de 24 horas.</li>
      </ul>
    </aside>
  </section>;
}
