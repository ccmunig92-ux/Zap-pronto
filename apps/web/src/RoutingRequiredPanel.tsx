import { useEffect, useRef, useState } from "react";
import type { ListRoutingRequiredResponse, RoutingRequiredItem } from "@zap-pronto/contracts";
import { ApiProblem, AuthenticationRequired } from "@zap-pronto/api-client";

export interface RoutingRequiredClient {
  listRoutingRequired(input?: { limit?: number; cursor?: string }): Promise<ListRoutingRequiredResponse>;
  resolveRoutingRequired(receiptId: string, unitId: string, idempotencyKey: string): Promise<{ replayed: boolean }>;
}

type Intent = { readonly receiptId: string; readonly unitId: string; readonly key: string };

export function RoutingRequiredPanel({ client, canResolve, onAuthenticationRequired, onAuthorizationChanged,
  onNavigationStateChange }: {
  readonly client: RoutingRequiredClient;
  readonly canResolve: boolean;
  readonly onAuthenticationRequired: () => void;
  readonly onAuthorizationChanged: () => void;
  readonly onNavigationStateChange?: (state: { readonly blocked: boolean; readonly dirty: boolean }) => void;
}) {
  const [page, setPage] = useState<ListRoutingRequiredResponse>();
  const [loading, setLoading] = useState(true);
  const [pageLoading, setPageLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [working, setWorking] = useState<string>();
  const mounted = useRef(false);
  const generation = useRef(0);
  const listFlight = useRef(false);
  const mutationLock = useRef<symbol | undefined>(undefined);
  const intent = useRef<Intent | undefined>(undefined);
  const navigationCallback = useRef(onNavigationStateChange);

  useEffect(() => { navigationCallback.current = onNavigationStateChange; }, [onNavigationStateChange]);
  useEffect(() => {
    onNavigationStateChange?.({
      blocked: Boolean(working),
      dirty: Object.values(selected).some(Boolean) || intent.current !== undefined,
    });
  }, [onNavigationStateChange, selected, working]);
  useEffect(() => () => navigationCallback.current?.({ blocked: false, dirty: false }), []);

  function clearSensitiveState(): void {
    setPage(undefined);
    setSelected({});
    setError(undefined);
    setNotice(undefined);
    setLoading(false);
    setPageLoading(false);
    setRefreshing(false);
    setWorking(undefined);
    listFlight.current = false;
    mutationLock.current = undefined;
    intent.current = undefined;
  }

  function purge(): void {
    generation.current += 1;
    clearSensitiveState();
  }

  function authFailure(cause: unknown): boolean {
    if (cause instanceof AuthenticationRequired || cause instanceof ApiProblem && cause.problem.status === 401) {
      purge();
      onAuthenticationRequired();
      return true;
    }
    if (cause instanceof ApiProblem && cause.problem.status === 403) {
      purge();
      onAuthorizationChanged();
      return true;
    }
    return false;
  }

  async function load(mode: "initial" | "refresh", cursor?: string): Promise<void> {
    if (listFlight.current || mutationLock.current) return;
    listFlight.current = true;
    const g = mode === "refresh" || mode === "initial" ? ++generation.current : generation.current;
    if (mode === "initial") setLoading(true);
    else setRefreshing(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const next = await client.listRoutingRequired({ limit: 25, ...(cursor ? { cursor } : {}) });
      if (!mounted.current || g !== generation.current) return;
      const items = [...new Map(next.items.map(item => [item.receiptId, item])).values()];
      setPage({ items, ...(next.nextCursor ? { nextCursor: next.nextCursor } : {}) });
      setSelected(current => Object.fromEntries(Object.entries(current).filter(([receiptId, unitId]) =>
        items.some(item => item.receiptId === receiptId && item.eligibleUnits.some(unit => unit.id === unitId)))));
    } catch (cause) {
      if (!mounted.current || g !== generation.current) return;
      if (!authFailure(cause)) setError("Não foi possível carregar a fila de roteamento.");
    } finally {
      if (mounted.current && g === generation.current) {
        listFlight.current = false;
        setLoading(false);
        setRefreshing(false);
      }
    }
  }

  async function loadMore(cursor: string): Promise<void> {
    if (listFlight.current || mutationLock.current) return;
    listFlight.current = true;
    const g = generation.current;
    setPageLoading(true);
    setError(undefined);
    try {
      const next = await client.listRoutingRequired({ limit: 25, cursor });
      if (!mounted.current || g !== generation.current) return;
      setPage(current => {
        const items = [...new Map([...(current?.items ?? []), ...next.items].map(item => [item.receiptId, item])).values()];
        return { items, ...(next.nextCursor ? { nextCursor: next.nextCursor } : {}) };
      });
    } catch (cause) {
      if (!mounted.current || g !== generation.current) return;
      if (!authFailure(cause)) setError("Não foi possível carregar mais atendimentos.");
    } finally {
      if (mounted.current && g === generation.current) {
        listFlight.current = false;
        setPageLoading(false);
      }
    }
  }

  useEffect(() => {
    mounted.current = true;
    void load("initial");
    return () => {
      mounted.current = false;
      generation.current += 1;
      listFlight.current = false;
      mutationLock.current = undefined;
      intent.current = undefined;
    };
  }, [client]);

  async function resolve(item: RoutingRequiredItem): Promise<void> {
    const unitId = selected[item.receiptId];
    if (!unitId || mutationLock.current || listFlight.current) return;
    const eligible = item.eligibleUnits.some(unit => unit.id === unitId);
    if (!eligible) return;
    const token = Symbol();
    mutationLock.current = token;
    const g = generation.current;
    const activeIntent = intent.current?.receiptId === item.receiptId && intent.current.unitId === unitId
      ? intent.current : { receiptId: item.receiptId, unitId, key: crypto.randomUUID() };
    intent.current = activeIntent;
    setWorking(item.receiptId);
    setError(undefined);
    setNotice(undefined);
    try {
      await client.resolveRoutingRequired(activeIntent.receiptId, activeIntent.unitId, activeIntent.key);
      if (!mounted.current || g !== generation.current) return;
      intent.current = undefined;
      setPage(current => current ? { ...current, items: current.items.filter(candidate => candidate.receiptId !== item.receiptId) } : current);
      setSelected(current => { const next = { ...current }; delete next[item.receiptId]; return next; });
    } catch (cause) {
      if (!mounted.current || g !== generation.current) return;
      if (authFailure(cause)) return;
      if (cause instanceof ApiProblem && (cause.problem.status === 404 || cause.problem.status === 409)) {
        intent.current = undefined;
        mutationLock.current = undefined;
        setWorking(undefined);
        await load("refresh");
        if (mounted.current) setNotice(cause.problem.status === 404
          ? "O atendimento não está mais disponível. A fila foi atualizada."
          : "O atendimento foi alterado. A fila foi atualizada.");
        return;
      }
      setError("Não foi possível encaminhar o atendimento.");
    } finally {
      if (mutationLock.current === token) mutationLock.current = undefined;
      if (mounted.current && g === generation.current) setWorking(undefined);
    }
  }

  const busy = loading || pageLoading || refreshing || Boolean(working);
  return <section className="routing-required">
    <h2>Aguardando unidade</h2>
    <button type="button" disabled={busy} onClick={() => void load("refresh")}>{refreshing ? "Atualizando…" : "Atualizar fila"}</button>
    {loading && !page && <p>Carregando fila…</p>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!loading && page?.items.length === 0 && <p>Nenhum atendimento aguardando unidade.</p>}
    <ul>{page?.items.map(item => <li key={item.receiptId}>
      <strong>{item.provider} · {item.kind}</strong>
      <span>{new Date(item.receivedAt).toLocaleString("pt-BR")}</span>
      <select aria-label={`Unidade para ${item.receiptId}`} value={selected[item.receiptId] ?? ""}
        disabled={busy} onChange={event => {
          const unitId = event.target.value;
          intent.current = intent.current?.receiptId === item.receiptId && intent.current.unitId !== unitId ? undefined : intent.current;
          setSelected(value => ({ ...value, [item.receiptId]: unitId }));
        }}>
        <option value="">Selecione a unidade</option>
        {item.eligibleUnits.map(unit => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
      </select>
      {canResolve && item.allowedActions.includes("RESOLVE") && <button type="button"
        disabled={!selected[item.receiptId] || busy} onClick={() => void resolve(item)}>
        {working === item.receiptId ? "Resolvendo…" : "Encaminhar para unidade"}
      </button>}
    </li>)}</ul>
    {page?.nextCursor && <button type="button" disabled={busy} onClick={() => void loadMore(page.nextCursor!)}>
      {pageLoading ? "Carregando…" : "Carregar mais"}
    </button>}
  </section>;
}
