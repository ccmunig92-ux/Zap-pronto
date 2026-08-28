// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiProblem, AuthenticationRequired } from "@zap-pronto/api-client";
import { ConnectionsPanel } from "./ConnectionsPanel.js";

describe("ConnectionsPanel", () => {
  afterEach(cleanup);
  const client = { listChannelConnections: vi.fn().mockResolvedValue({ items: [] }) };
  const connection = {
    id: "a4000000-0000-4000-8000-000000000003", type: "WHATSAPP" as const, scope: "CORPORATE" as const,
    displayName: "Principal", wabaId: "123456", phoneNumberId: "654321", status: "DISCONNECTED",
    secretConfigured: true, unitIds: [],
  };
  async function openAndFill(setChannelConnectionMetadata: ReturnType<typeof vi.fn>) {
    render(<ConnectionsPanel client={{ listChannelConnections: vi.fn().mockResolvedValue({ items: [] }), setChannelConnectionMetadata }} canManage />);
    fireEvent.click(await screen.findByRole("button", { name: "Configurar conexão" }));
    fireEvent.change(screen.getByLabelText("Nome da conexão"), { target: { value: "Principal" } });
    fireEvent.change(screen.getByLabelText("WABA ID"), { target: { value: "123456" } });
    fireEvent.change(screen.getByLabelText("Phone Number ID"), { target: { value: "654321" } });
    fireEvent.change(screen.getByLabelText(/Referência protegida do segredo/), { target: { value: "meta.production" } });
  }
  it("exibe o estado canônico sem coletar segredo no navegador", async () => {
    render(<ConnectionsPanel client={client} canManage onNavigationStateChange={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Canais e integrações" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Nenhuma conexão WhatsApp foi cadastrada neste tenant.")).toBeTruthy());
    expect(screen.getByText("Configuração pendente")).toBeTruthy();
    expect(screen.queryByLabelText(/token|senha|secret/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Configurar conexão" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Abrir conversa de teste" }).hasAttribute("disabled")).toBe(true);
  });

  it("informa que a configuração exige permissão de tenant", async () => {
    render(<ConnectionsPanel client={client} canManage={false} />);
    expect(screen.getByText("Somente administradores do tenant podem configurar canais.")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "Configurar conexão" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Configurar conexão" }).hasAttribute("disabled")).toBe(true);
  });

  it("exibe somente metadados não secretos da conexão retornada pela API", async () => {
    const connectedClient = { listChannelConnections: vi.fn().mockResolvedValue({ items: [{
      id: "a4000000-0000-4000-8000-000000000001", type: "WHATSAPP", scope: "CORPORATE",
      displayName: "Medilife", wabaId: "waba-1", phoneNumberId: "phone-1", status: "ACTIVE",
      secretConfigured: true, unitIds: [],
    }] }) };
    render(<ConnectionsPanel client={connectedClient} canManage />);
    await waitFor(() => expect(screen.getByText("waba-1")).toBeTruthy());
    expect(screen.getByText("Conexão cadastrada").classList.contains("connection-status-active")).toBe(true);
    expect(screen.getByText("Secret configurado no servidor")).toBeTruthy();
    expect(screen.getAllByText("Corporativa · todas as unidades").length).toBeGreaterThan(0);
    expect(screen.getByText("Ativa")).toBeTruthy();
    expect(screen.queryByLabelText(/token|senha|secret/i)).toBeNull();
  });

  it("representa escopo multiunidade sem associar a conexão a uma única unidade", async () => {
    const selectedUnitsClient = { listChannelConnections: vi.fn().mockResolvedValue({ items: [{
      id: "a4000000-0000-4000-8000-000000000002", type: "WHATSAPP", scope: "SELECTED_UNITS",
      displayName: "Regional", wabaId: "waba-2", phoneNumberId: "phone-2", status: "DEGRADED",
      secretConfigured: false, unitIds: ["unit-a", "unit-b"],
    }] }) };
    render(<ConnectionsPanel client={selectedUnitsClient} canManage units={[{ id: "unit-a", name: "Centro" }]} />);
    await waitFor(() => expect(screen.getAllByText("2 unidades selecionadas").length).toBeGreaterThan(0));
    expect(screen.getByText("Unidades vinculadas: Centro, unit-b")).toBeTruthy();
    expect(screen.getByText("Degradada")).toBeTruthy();
    expect(screen.getByText("Não configurado")).toBeTruthy();
  });

  it("reutiliza a chave no retry idêntico e cria outra quando o payload muda", async () => {
    const set = vi.fn().mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ connection, replayed: false });
    await openAndFill(set);
    fireEvent.click(screen.getByRole("button", { name: "Salvar conexão" }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Salvar conexão" }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(2));
    expect(set.mock.calls[1]![1]).toBe(set.mock.calls[0]![1]);
    fireEvent.change(screen.getByLabelText("Nome da conexão"), { target: { value: "Principal alterada" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar conexão" }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(3));
    expect(set.mock.calls[2]![1]).not.toBe(set.mock.calls[1]![1]);
    expect(await screen.findByText("Conexão cadastrada")).toBeTruthy();
  });

  it("bloqueia escopo que exige unidade antes de enviar", async () => {
    const set = vi.fn();
    await openAndFill(set);
    fireEvent.change(screen.getByLabelText("Escopo"), { target: { value: "SELECTED_UNITS" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar conexão" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Selecione as unidades exigidas pelo escopo da conexão.");
    expect(set).not.toHaveBeenCalled();
  });

  it("trata 400 sem expor detalhes retornados pela API", async () => {
    const set = vi.fn().mockRejectedValue(new ApiProblem({ type: "urn:test", title: "segredo privado", status: 400, correlationId: "private" }));
    await openAndFill(set);
    fireEvent.click(screen.getByRole("button", { name: "Salvar conexão" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Revise os dados da conexão e tente novamente.");
    expect(document.body.textContent).not.toContain("segredo privado");
  });

  it("encaminha sessão expirada sem vazar a falha", async () => {
    const callback = vi.fn();
    const set = vi.fn().mockRejectedValue(new AuthenticationRequired());
    render(<ConnectionsPanel client={{ listChannelConnections: vi.fn().mockResolvedValue({ items: [] }), setChannelConnectionMetadata: set }} canManage onAuthenticationRequired={callback} />);
    fireEvent.click(await screen.findByRole("button", { name: "Configurar conexão" }));
    fireEvent.change(screen.getByLabelText("WABA ID"), { target: { value: "123456" } });
    fireEvent.change(screen.getByLabelText("Phone Number ID"), { target: { value: "654321" } });
    fireEvent.change(screen.getByLabelText(/Referência protegida do segredo/), { target: { value: "meta.production" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar conexão" }));
    await waitFor(() => expect(callback).toHaveBeenCalledOnce());
  });

  it.each([403, 409])("apresenta tratamento seguro para falha %i", async status => {
    const callback = vi.fn();
    const set = vi.fn().mockRejectedValue(new ApiProblem({ type: "urn:test", title: "segredo privado", status, correlationId: "private" }));
    render(<ConnectionsPanel client={{ listChannelConnections: vi.fn().mockResolvedValue({ items: [] }), setChannelConnectionMetadata: set }} canManage onAuthorizationChanged={callback} />);
    fireEvent.click(await screen.findByRole("button", { name: "Configurar conexão" }));
    fireEvent.change(screen.getByLabelText("WABA ID"), { target: { value: "123456" } });
    fireEvent.change(screen.getByLabelText("Phone Number ID"), { target: { value: "654321" } });
    fireEvent.change(screen.getByLabelText(/Referência protegida do segredo/), { target: { value: "meta.production" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar conexão" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(status === 403 ? /não tem permissão/ : /alterada por outra operação/);
    expect(document.body.textContent).not.toContain("segredo privado");
    expect(callback).toHaveBeenCalledTimes(status === 403 ? 1 : 0);
  });
});
