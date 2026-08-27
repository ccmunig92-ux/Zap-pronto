import { useEffect, useState } from "react";
import type { ChannelConnection, ChannelConnectionMetadataRequest, ChannelConnectionsPage } from "@zap-pronto/contracts";
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
  readonly units?: readonly { id: string; name: string }[];
  readonly client?: { listChannelConnections(): Promise<ChannelConnectionsPage>; setChannelConnectionMetadata?(input: ChannelConnectionMetadataRequest, idempotencyKey: string): Promise<{ connection: ChannelConnection; replayed: boolean }> };
  readonly onAuthenticationRequired?: () => void;
  readonly onAuthorizationChanged?: () => void;
  readonly onNavigationStateChange?: (state: NavigationState) => void;
}

export function ConnectionsPanel({ canManage, units = [], client, onAuthenticationRequired, onAuthorizationChanged, onNavigationStateChange }: ConnectionsPanelProps) {
  const [page, setPage] = useState<ChannelConnectionsPage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<ChannelConnection>();
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ displayName: "", wabaId: "", phoneNumberId: "", status: "DISCONNECTED" as ChannelConnectionMetadataRequest["status"], scope: "CORPORATE" as ChannelConnectionMetadataRequest["scope"], secretReference: "", unitIds: [] as string[] });
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
  const headerStatus = loading ? "Carregando…" : connections.length ? "Conexão cadastrada" : "Configuração pendente";
  const headerStatusClass = loading ? "connection-status-pending" : connections.length ? "connection-status-active" : "connection-status-pending";
  const statusLabel = (status:string) => status === "ACTIVE" ? "Ativa" : status === "DEGRADED" ? "Degradada" : "Desconectada";
  const scopeLabel = (scope:string, unitIds:readonly string[]) => scope === "CORPORATE" ? "Corporativa · todas as unidades" :
    scope === "SINGLE_UNIT" ? "Uma unidade" : `${unitIds.length} unidades selecionadas`;
  function openForm(connection?: ChannelConnection): void {
    if (connection && !window.confirm("Confirmar edição desta conexão?")) return;
    setEditing(connection);
    setFormOpen(true);
    setForm({ displayName: connection?.displayName ?? "", wabaId: connection?.wabaId ?? "", phoneNumberId: connection?.phoneNumberId ?? "", status: (connection?.status === "ACTIVE" || connection?.status === "DEGRADED" ? connection.status : "DISCONNECTED"), scope: connection?.scope ?? "CORPORATE", secretReference: connection ? "preservar-atual" : "", unitIds: [...(connection?.unitIds ?? [])] });
  }
  function updateScope(scope: ChannelConnectionMetadataRequest["scope"]): void { setForm(current => ({ ...current, scope, unitIds: scope === "CORPORATE" ? [] : scope === "SINGLE_UNIT" ? current.unitIds.slice(0, 1) : current.unitIds })); }
  async function save(): Promise<void> {
    if (!client?.setChannelConnectionMetadata) return;
    const validUnits = form.scope === "CORPORATE" ? [] : form.unitIds;
    if ((form.scope === "SINGLE_UNIT" && validUnits.length !== 1) || (form.scope === "SELECTED_UNITS" && (validUnits.length < 1 || validUnits.length > 100))) { setError("Selecione as unidades exigidas pelo escopo da conexão."); return; }
    if (!form.secretReference) { setError("Informe a referência protegida do segredo."); return; }
    setSaving(true); setError(undefined);
    try {
      const payload: ChannelConnectionMetadataRequest = { scope: form.scope, wabaId: form.wabaId, phoneNumberId: form.phoneNumberId, status: form.status, secretReference: form.secretReference, unitIds: validUnits };
      if (form.displayName) payload.displayName = form.displayName;
      if (editing) payload.id = editing.id;
      const response = await client.setChannelConnectionMetadata(payload, crypto.randomUUID());
      setPage(current => ({ items: editing ? current?.items.map(item => item.id === response.connection.id ? response.connection : item) ?? [response.connection] : [...(current?.items ?? []), response.connection] }));
      setEditing(undefined); setFormOpen(false); setForm(current => ({ ...current, secretReference: "" }));
    } catch (cause: unknown) {
      if (cause instanceof AuthenticationRequired || cause instanceof ApiProblem && cause.problem.status === 401) { onAuthenticationRequired?.(); return; }
      if (cause instanceof ApiProblem && cause.problem.status === 403) { onAuthorizationChanged?.(); setError("Você não tem permissão para alterar os canais deste tenant."); return; }
      if (cause instanceof ApiProblem && cause.problem.status === 409) { setError("A conexão foi alterada por outra operação. Atualize a lista e tente novamente."); return; }
      setError("Não foi possível salvar a conexão de canal.");
    } finally { setSaving(false); }
  }

  return <section className="connections-panel" aria-labelledby="connections-heading">
    <div className="panel-heading">
      <div>
        <p className="eyebrow">Integrações corporativas</p>
        <h2 id="connections-heading" tabIndex={-1}>Canais e integrações</h2>
      </div>
      <span className={`connection-status ${headerStatusClass}`} role="status">{headerStatus}</span>
    </div>
    <p className="connections-description">Acompanhe as conexões de canal, o escopo de atendimento e a disponibilidade da referência protegida no servidor.</p>
    {!canManage && <p className="connection-readonly" role="status"><strong>Modo somente leitura.</strong> Somente administradores do tenant podem configurar canais.</p>}
    {error && <p role="alert">{error}</p>}
    {loading && <div className="connection-loading" aria-busy="true" aria-live="polite"><span/><span/><span/><p>Carregando conexões…</p></div>}
    {!loading && !error && connections.length === 0 && <>
      <div className="connection-empty" role="status"><span className="connection-empty-mark" aria-hidden="true">W</span><div><strong>Nenhuma conexão WhatsApp foi cadastrada neste tenant.</strong><p>Cadastre uma conexão administrativa para que as unidades autorizadas recebam mensagens.</p></div></div>
      <article className="connection-card connection-card-placeholder">
        <div className="connection-card-title"><div><p className="eyebrow">Canal disponível</p><h3>WhatsApp Cloud API</h3><p className="muted">Aguardando configuração administrativa.</p></div><span className="connection-badge connection-badge-disconnected">Não conectado</span></div>
        <div className="connection-actions">
          <button type="button" disabled={!canManage || !client?.setChannelConnectionMetadata} onClick={() => openForm()} title="Cadastre os metadados e a referência protegida no servidor">Configurar conexão</button>
          <button type="button" disabled title="O QR Code não autentica uma conexão Cloud API">Abrir conversa de teste</button>
        </div>
      </article>
    </>}
    {!loading && !error && connections.length>0&&<div className="connection-grid">{connections.map(connection => <article className="connection-card" key={connection.id}>
      <div className="connection-card-title">
        <div>
          <p className="eyebrow">WhatsApp</p>
          <h3>WhatsApp Cloud API</h3>
          <p className="muted">{connection.displayName ?? "Conexão corporativa"} — pode atender mais de uma unidade.</p>
        </div>
        <span className={`connection-badge connection-badge-${connection.status.toLowerCase()}`}>{statusLabel(connection.status)}</span>
      </div>
      <p className="connection-scope">{scopeLabel(connection.scope,connection.unitIds)}</p>
      <dl className="connection-metadata">
        <div><dt>WABA</dt><dd>{connection.wabaId || "Não informado"}</dd></div>
        <div><dt>Phone Number ID</dt><dd>{connection.phoneNumberId}</dd></div>
        <div><dt>Escopo</dt><dd>{scopeLabel(connection.scope,connection.unitIds)}</dd></div>
        <div className={connection.secretConfigured?"connection-secret-ok":"connection-secret-missing"}><dt>Referência protegida</dt><dd>{connection.secretConfigured ? "Configurado no servidor" : "Não configurado"}</dd></div>
      </dl>
      <div className="connection-actions">
        <button type="button" disabled={!canManage || !client?.setChannelConnectionMetadata} onClick={() => openForm(connection)}>
          Editar conexão
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
    </article>)}</div>}
    {formOpen && <form className="connection-form" onSubmit={event => { event.preventDefault(); void save(); }} aria-label={editing ? "Editar conexão" : "Configurar conexão"}>
      <h3>{editing ? "Editar conexão" : "Configurar conexão"}</h3>
      <label>Nome da conexão<input value={form.displayName} onChange={event => setForm(current => ({ ...current, displayName: event.target.value }))} /></label>
      <label>WABA ID<input required inputMode="numeric" value={form.wabaId} onChange={event => setForm(current => ({ ...current, wabaId: event.target.value }))} /></label>
      <label>Phone Number ID<input required inputMode="numeric" value={form.phoneNumberId} onChange={event => setForm(current => ({ ...current, phoneNumberId: event.target.value }))} /></label>
      <label>Referência protegida do segredo<input required pattern="[A-Za-z0-9._-]+" value={form.secretReference} onChange={event => setForm(current => ({ ...current, secretReference: event.target.value }))} /><small>O segredo real permanece no servidor.</small></label>
      <label>Escopo<select value={form.scope} onChange={event => updateScope(event.target.value as ChannelConnectionMetadataRequest["scope"])}><option value="CORPORATE">Corporativo</option><option value="SINGLE_UNIT">Uma unidade</option><option value="SELECTED_UNITS">Unidades selecionadas</option></select></label>
      {form.scope !== "CORPORATE" && <fieldset><legend>Unidades</legend>{units.map(unit => <label key={unit.id}><input type="checkbox" checked={form.unitIds.includes(unit.id)} onChange={event => setForm(current => ({ ...current, unitIds: event.target.checked ? [...current.unitIds, unit.id] : current.unitIds.filter(id => id !== unit.id) }))} />{unit.name}</label>)}</fieldset>}
      <label>Status<select value={form.status} onChange={event => setForm(current => ({ ...current, status: event.target.value as ChannelConnectionMetadataRequest["status"] }))}><option value="ACTIVE">Ativa</option><option value="DEGRADED">Degradada</option><option value="DISCONNECTED">Desconectada</option></select></label>
      <div className="connection-actions"><button type="submit" disabled={saving}>{saving ? "Salvando…" : "Salvar conexão"}</button><button type="button" onClick={() => { setEditing(undefined); setFormOpen(false); }} disabled={saving}>Cancelar</button></div>
    </form>}
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
