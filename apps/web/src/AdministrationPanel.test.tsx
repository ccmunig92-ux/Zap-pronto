// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdministrativeInvitation, AdministrativeUser } from "@zap-pronto/contracts";
import { AdministrationPanel, type AdministrationClient } from "./AdministrationPanel.js";

const user: AdministrativeUser = {
  id: "22222222-2222-4222-8222-222222222222", email: "agent@example.test", displayName: "Agente",
  status: "ACTIVE", version: 7, memberships: [], allowedActions: ["BLOCK"],
};
const invitation: AdministrativeInvitation = {
  id: "44444444-4444-4444-8444-444444444444", email: "new@example.test", displayName: "Nova pessoa",
  status: "EXPIRED", expiresAt: "2026-08-05T12:00:00.000Z", providerCode: "primary", assignments: [],
  allowedActions: ["REISSUE"],
};

function client(overrides: Partial<AdministrationClient> = {}): AdministrationClient {
  return {
    async listAdministrativeUsers() { return { items: [user] }; },
    async listAdministrativeInvitations() { return { items: [invitation] }; },
    async changeAdministrativeUserStatus() { return {}; },
    async revokeUserInvitation() { return {}; },
    async reissueUserInvitation() { return { invitation, replayed: true }; },
    ...overrides,
  };
}

afterEach(cleanup);
describe("administrative lifecycle", () => {
  it("renders only server-allowed actions and submits id/version after confirmation", async () => {
    const change = vi.fn<AdministrationClient["changeAdministrativeUserStatus"]>(async () => ({}));
    render(<AdministrationPanel client={client({ changeAdministrativeUserStatus: change })}/>);
    expect(await screen.findByText("Agente")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bloquear" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reativar" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Bloquear" }));
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "Solicitação administrativa" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar bloquear" }));
    await screen.findByText("Agente");
    expect(change).toHaveBeenCalledTimes(1);
    expect(change.mock.calls[0]?.[0]).toBe(user.id);
    expect(change.mock.calls[0]?.[1]).toEqual({ action: "BLOCK", expectedVersion: 7,
      reason: "Solicitação administrativa" });
    expect(change.mock.calls[0]?.[2]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps a reissued token transient and removes it when closed", async () => {
    const token = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
    const reissue = vi.fn(async () => ({ invitation: { ...invitation, status: "PENDING" as const },
      replayed: false as const, invitationToken: token }));
    render(<AdministrationPanel client={client({ reissueUserInvitation: reissue })}/>);
    await screen.findByText("Nova pessoa");
    fireEvent.click(screen.getByRole("button", { name: "Reemitir" }));
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "Convite anterior expirado" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar reemitir" }));
    expect(await screen.findByText("Entrega manual do novo convite")).toBeTruthy();
    expect(screen.queryByText(token)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Revelar" }));
    expect(screen.getByText(token)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fechar e apagar token" }));
    expect(screen.queryByText(token)).toBeNull();
    expect(reissue).toHaveBeenCalledTimes(1);
  });

  it("does not retry a failed lifecycle mutation automatically", async () => {
    const change = vi.fn<AdministrationClient["changeAdministrativeUserStatus"]>(async () => {
      throw new Error("network");
    });
    render(<AdministrationPanel client={client({ changeAdministrativeUserStatus: change })}/>);
    await screen.findByText("Agente");
    fireEvent.click(screen.getByRole("button", { name: "Bloquear" }));
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "Solicitação administrativa" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar bloquear" }));
    expect(await screen.findByText("Não foi possível concluir a ação.")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("paginates users with the opaque cursor returned by the API", async () => {
    const second = { ...user, id: "55555555-5555-4555-8555-555555555555", displayName: "Segundo" };
    const list = vi.fn<AdministrationClient["listAdministrativeUsers"]>(async (input = {}) =>
      input.cursor ? { items: [second] } : { items: [user], nextCursor: "opaque-cursor" });
    render(<AdministrationPanel client={client({ listAdministrativeUsers: list })}/>);
    await screen.findByText("Agente");
    fireEvent.click(screen.getByRole("button", { name: "Carregar mais usuários" }));
    expect(await screen.findByText("Segundo")).toBeTruthy();
    expect(list).toHaveBeenLastCalledWith({ limit: 25, cursor: "opaque-cursor" });
    expect(screen.queryByRole("button", { name: "Carregar mais usuários" })).toBeNull();
  });
});
