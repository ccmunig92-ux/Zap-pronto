// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiProblem, AuthenticationRequired } from "@zap-pronto/api-client";
import { RoutingRequiredPanel, type RoutingRequiredClient } from "./RoutingRequiredPanel.js";

const unitId = "30000000-0000-4000-8000-000000000001";
const item = { receiptId: "10000000-0000-4000-8000-000000000001", channelConnectionId: "20000000-0000-4000-8000-000000000001",
  provider: "META_WHATSAPP", kind: "TEXT", occurredAt: "2026-08-10T10:00:00.000Z", receivedAt: "2026-08-10T10:00:01.000Z",
  eligibleUnits: [{ id: unitId, code: "CENTRO", name: "Centro" }], allowedActions: ["RESOLVE" as const] };
const second = { ...item, receiptId: "10000000-0000-4000-8000-000000000002" };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function problem(status: number) { return new ApiProblem({ type: "about:blank", title: "unsafe telefone 5511999999999", status,
  detail: "sender secret", correlationId: `corr-${status}` }); }
function client(overrides: Partial<RoutingRequiredClient> = {}): RoutingRequiredClient { return {
  async listRoutingRequired() { return { items: [item] }; }, async resolveRoutingRequired() { return { replayed: false }; }, ...overrides };
}
function panel(api: RoutingRequiredClient, callbacks: { auth?: () => void; authorization?: () => void } = {}) {
  return render(<RoutingRequiredPanel client={api} canResolve onAuthenticationRequired={callbacks.auth ?? (() => undefined)}
    onAuthorizationChanged={callbacks.authorization ?? (() => undefined)}/>);
}
afterEach(cleanup);

describe("RoutingRequiredPanel", () => {
  it("renders only the safe projection and resolves an eligible unit", async () => {
    const resolve = vi.fn(async () => ({ replayed: false })); panel(client({ resolveRoutingRequired: resolve }));
    expect(await screen.findByText("META_WHATSAPP · TEXT")).toBeTruthy();
    expect(screen.queryByText(/sender|telefone|mediaId/i)).toBeNull();
    fireEvent.change(screen.getByLabelText(`Unidade para ${item.receiptId}`), { target: { value: unitId } });
    fireEvent.click(screen.getByRole("button", { name: "Encaminhar para unidade" }));
    expect(await screen.findByText("Nenhum atendimento aguardando unidade.")).toBeTruthy();
    expect(resolve.mock.calls[0]?.slice(0, 2)).toEqual([item.receiptId, unitId]);
  });

  it("uses one synchronous mutation lock and the same intent key on retry", async () => {
    const resolve = vi.fn().mockRejectedValueOnce(new Error("secret")).mockResolvedValueOnce({ replayed: false });
    panel(client({ resolveRoutingRequired: resolve })); await screen.findByText("META_WHATSAPP · TEXT");
    fireEvent.change(screen.getByLabelText(`Unidade para ${item.receiptId}`), { target: { value: unitId } });
    const button = screen.getByRole("button", { name: "Encaminhar para unidade" }); fireEvent.click(button); fireEvent.click(button);
    await screen.findByRole("alert"); expect(resolve).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Encaminhar para unidade" }));
    await screen.findByText("Nenhum atendimento aguardando unidade.");
    expect(resolve).toHaveBeenCalledTimes(2); expect(resolve.mock.calls[1]?.[2]).toBe(resolve.mock.calls[0]?.[2]);
  });

  it("deduplicates pages and keeps pagination single-flight", async () => {
    const page = deferred<{ items: typeof item[]; nextCursor?: string }>();
    const list = vi.fn().mockResolvedValueOnce({ items: [item], nextCursor: "next" }).mockReturnValueOnce(page.promise);
    panel(client({ listRoutingRequired: list })); await screen.findByText("META_WHATSAPP · TEXT");
    const more = screen.getByRole("button", { name: "Carregar mais" }); fireEvent.click(more); fireEvent.click(more);
    expect(list).toHaveBeenCalledTimes(2); page.resolve({ items: [item, second] });
    await screen.findByLabelText(`Unidade para ${second.receiptId}`);
    expect(screen.getAllByText("META_WHATSAPP · TEXT")).toHaveLength(2);
  });

  it("refresh is GET-only, single-flight, and replaces the snapshot atomically", async () => {
    const refresh = deferred<{ items: typeof item[] }>();
    const list = vi.fn().mockResolvedValueOnce({ items: [item] }).mockReturnValueOnce(refresh.promise);
    const resolve = vi.fn(); panel(client({ listRoutingRequired: list, resolveRoutingRequired: resolve }));
    await screen.findByText("META_WHATSAPP · TEXT"); const button = screen.getByRole("button", { name: "Atualizar fila" });
    fireEvent.click(button); fireEvent.click(button); expect(list).toHaveBeenCalledTimes(2); expect(resolve).not.toHaveBeenCalled();
    expect(screen.getByText("META_WHATSAPP · TEXT")).toBeTruthy(); refresh.resolve({ items: [second] });
    await waitFor(() => expect(screen.queryByLabelText(`Unidade para ${item.receiptId}`)).toBeNull());
    expect(screen.getByLabelText(`Unidade para ${second.receiptId}`)).toBeTruthy();
  });

  it.each([[401, "auth"], [403, "authorization"]] as const)("purges before the %i callback and ignores late data", async (status, callbackName) => {
    const late = deferred<{ items: typeof item[] }>(); const callback = vi.fn();
    const list = vi.fn().mockResolvedValueOnce({ items: [item], nextCursor: "next" })
      .mockRejectedValueOnce(status === 401 ? new AuthenticationRequired() : problem(403)).mockReturnValueOnce(late.promise);
    panel(client({ listRoutingRequired: list }), callbackName === "auth" ? { auth: callback } : { authorization: callback });
    await screen.findByText("META_WHATSAPP · TEXT"); fireEvent.click(screen.getByRole("button", { name: "Carregar mais" }));
    await waitFor(() => expect(callback).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByText("META_WHATSAPP · TEXT")).toBeNull());
    late.resolve({ items: [second] }); await Promise.resolve(); expect(screen.queryByText("META_WHATSAPP · TEXT")).toBeNull();
  });

  it.each([404, 409])("reconciles %i with a fresh GET and clears the stale intent", async status => {
    const resolve = vi.fn().mockRejectedValueOnce(problem(status)).mockResolvedValueOnce({ replayed: false });
    const list = vi.fn().mockResolvedValueOnce({ items: [item] }).mockResolvedValueOnce({ items: [item] });
    panel(client({ listRoutingRequired: list, resolveRoutingRequired: resolve })); await screen.findByText("META_WHATSAPP · TEXT");
    fireEvent.change(screen.getByLabelText(`Unidade para ${item.receiptId}`), { target: { value: unitId } });
    fireEvent.click(screen.getByRole("button", { name: "Encaminhar para unidade" }));
    await screen.findByRole("status"); expect(list).toHaveBeenCalledTimes(2);
    fireEvent.change(screen.getByLabelText(`Unidade para ${item.receiptId}`), { target: { value: unitId } });
    fireEvent.click(screen.getByRole("button", { name: "Encaminhar para unidade" }));
    await screen.findByText("Nenhum atendimento aguardando unidade.");
    expect(resolve.mock.calls[1]?.[2]).not.toBe(resolve.mock.calls[0]?.[2]);
  });

  it("sanitizes server and runtime failures", async () => {
    panel(client({ async listRoutingRequired() { throw problem(500); } }));
    const alert = await screen.findByRole("alert"); expect(alert.textContent).toBe("Não foi possível carregar a fila de roteamento.");
    expect(alert.textContent).not.toMatch(/sender|telefone|5511999999999|corr-/i);
  });

  it("invalidates a late response on unmount and hides resolve without its grant", async () => {
    const late = deferred<{ items: typeof item[] }>(); const view = panel(client({ listRoutingRequired: () => late.promise }));
    view.unmount(); late.resolve({ items: [item] }); await Promise.resolve(); expect(screen.queryByText("META_WHATSAPP · TEXT")).toBeNull();
    render(<RoutingRequiredPanel client={client({ async listRoutingRequired() { return { items: [] }; } })} canResolve={false}
      onAuthenticationRequired={() => undefined} onAuthorizationChanged={() => undefined}/>);
    expect(await screen.findByText("Nenhum atendimento aguardando unidade.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Encaminhar para unidade" })).toBeNull();
  });

  it("reports dirty routing selections, blocks during mutation and clears navigation state on unmount", async () => {
    const pending = deferred<{ replayed: boolean }>(); const state = vi.fn();
    const view = render(<RoutingRequiredPanel client={client({ resolveRoutingRequired: () => pending.promise })}
      canResolve onAuthenticationRequired={() => undefined} onAuthorizationChanged={() => undefined}
      onNavigationStateChange={state}/>);
    await screen.findByText("META_WHATSAPP · TEXT");
    await waitFor(() => expect(state).toHaveBeenLastCalledWith({ blocked: false, dirty: false }));
    fireEvent.change(screen.getByLabelText(`Unidade para ${item.receiptId}`), { target: { value: unitId } });
    await waitFor(() => expect(state).toHaveBeenLastCalledWith({ blocked: false, dirty: true }));
    fireEvent.click(screen.getByRole("button", { name: "Encaminhar para unidade" }));
    await waitFor(() => expect(state).toHaveBeenLastCalledWith({ blocked: true, dirty: true }));
    view.unmount(); expect(state).toHaveBeenLastCalledWith({ blocked: false, dirty: false });
    pending.resolve({ replayed: false });
  });
});
