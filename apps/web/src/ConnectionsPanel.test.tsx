// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionsPanel } from "./ConnectionsPanel.js";

describe("ConnectionsPanel", () => {
  afterEach(cleanup);
  it("exibe o estado canônico sem coletar segredo no navegador", () => {
    render(<ConnectionsPanel canManage onNavigationStateChange={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Canais e integrações" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "WhatsApp Cloud API" })).toBeTruthy();
    expect(screen.getByText("Configuração pendente")).toBeTruthy();
    expect(screen.queryByLabelText(/token|senha|secret/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Conectar com Meta" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Abrir conversa de teste" }).hasAttribute("disabled")).toBe(true);
  });

  it("informa que a configuração exige permissão de tenant", () => {
    render(<ConnectionsPanel canManage={false} />);
    expect(screen.getByRole("status").textContent).toContain("Somente administradores do tenant");
    expect(screen.getByRole("button", { name: "Conectar com Meta" }).hasAttribute("disabled")).toBe(true);
  });
});
