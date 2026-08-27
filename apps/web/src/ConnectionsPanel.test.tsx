// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionsPanel } from "./ConnectionsPanel.js";

describe("ConnectionsPanel", () => {
  afterEach(cleanup);
  const client = { listChannelConnections: vi.fn().mockResolvedValue({ items: [] }) };
  it("exibe o estado canônico sem coletar segredo no navegador", async () => {
    render(<ConnectionsPanel client={client} canManage onNavigationStateChange={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Canais e integrações" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Nenhuma conexão WhatsApp foi cadastrada neste tenant.")).toBeTruthy());
    expect(screen.getByText("Configuração pendente")).toBeTruthy();
    expect(screen.queryByLabelText(/token|senha|secret/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Conectar com Meta" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Abrir conversa de teste" }).hasAttribute("disabled")).toBe(true);
  });

  it("informa que a configuração exige permissão de tenant", async () => {
    render(<ConnectionsPanel client={client} canManage={false} />);
    expect(screen.getByText("Somente administradores do tenant podem configurar canais.")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "Conectar com Meta" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Conectar com Meta" }).hasAttribute("disabled")).toBe(true);
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
    expect(screen.getByText("Configurado no servidor")).toBeTruthy();
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
    render(<ConnectionsPanel client={selectedUnitsClient} canManage />);
    await waitFor(() => expect(screen.getAllByText("2 unidades selecionadas").length).toBeGreaterThan(0));
    expect(screen.getByText("Degradada")).toBeTruthy();
    expect(screen.getByText("Não configurado")).toBeTruthy();
  });
});
