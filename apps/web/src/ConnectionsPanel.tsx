import { useEffect } from "react";
import type { NavigationState } from "./App.js";

/**
 * Canonical integration entry point. This panel intentionally does not collect
 * access tokens or pretend to connect Meta before the administrative API exists.
 * The OAuth/Embedded Signup flow must be completed server-side and return only
 * non-secret connection metadata to this view.
 */
export interface ConnectionsPanelProps {
  readonly canManage: boolean;
  readonly onNavigationStateChange?: (state: NavigationState) => void;
}

export function ConnectionsPanel({ canManage, onNavigationStateChange }: ConnectionsPanelProps) {
  useEffect(() => { onNavigationStateChange?.({ blocked: false, dirty: false }); }, [onNavigationStateChange]);

  return <section className="connections-panel" aria-labelledby="connections-heading">
    <div className="panel-heading">
      <div>
        <p className="eyebrow">Integrações corporativas</p>
        <h2 id="connections-heading" tabIndex={-1}>Canais e integrações</h2>
      </div>
      <span className="connection-status connection-status-pending">Configuração pendente</span>
    </div>
    <p>Conecte o WhatsApp Cloud API da organização para receber mensagens e enviar respostas pela Inbox.</p>
    {!canManage && <p role="status">Somente administradores do tenant podem configurar canais.</p>}
    <article className="connection-card">
      <div className="connection-card-title">
        <div>
          <h3>WhatsApp Cloud API</h3>
          <p className="muted">Conexão corporativa — pode atender mais de uma unidade.</p>
        </div>
        <span className="connection-badge">Não conectado</span>
      </div>
      <dl className="connection-metadata">
        <div><dt>WABA</dt><dd>—</dd></div>
        <div><dt>Phone Number ID</dt><dd>—</dd></div>
        <div><dt>Webhook</dt><dd>Não configurado</dd></div>
        <div><dt>Templates</dt><dd>Indisponíveis</dd></div>
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
    </article>
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
