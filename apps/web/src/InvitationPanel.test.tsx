// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateUserInvitationRequest } from "@zap-pronto/contracts";
import { InvitationPanel, type InvitationClient } from "./InvitationPanel.js";

const unitId = "33333333-3333-4333-8333-333333333333";
const options = {
  providers: [{ code: "primary" }],
  units: [{ id: unitId, code: "CENTRO", name: "Centro" }],
  roles: ["ATTENDANT" as const],
};

afterEach(cleanup);

describe("administrative invitation", () => {
  it("reports draft state and clears navigation state on unmount", async () => {
    const state = vi.fn();
    const view = render(<InvitationPanel client={{ async getUserInvitationOptions() { return options; },
      async createUserInvitation() { throw new Error("not called"); } }} onNavigationStateChange={state}/>);
    await screen.findByRole("option", { name: "primary" });
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Pessoa" } });
    await waitFor(() => expect(state).toHaveBeenLastCalledWith({ blocked: false, dirty: true }));
    view.unmount();
    expect(state).toHaveBeenLastCalledWith({ blocked: false, dirty: false });
  });

  it("uses only API options and reveals a newly issued token once", async () => {
    let submitted: CreateUserInvitationRequest | undefined;
    let key: string | undefined;
    const invitationToken = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
    const client: InvitationClient = {
      async getUserInvitationOptions() { return options; },
      async createUserInvitation(input, idempotencyKey) {
        submitted = input; key = idempotencyKey;
        return { invitation: { id: "44444444-4444-4444-8444-444444444444", email: input.email,
          displayName: input.displayName, status: "PENDING", expiresAt: input.expiresAt,
          providerCode: input.providerCode }, assignments: [{ unitId, unitCode: "CENTRO", unitName: "Centro",
          role: "ATTENDANT" }], replayed: false, invitationToken };
      },
    };
    render(<InvitationPanel client={client}/>);
    expect(await screen.findByRole("option", { name: "primary" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Centro (CENTRO)" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Pessoa" } });
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "pessoa@example.test" } });
    fireEvent.change(screen.getByLabelText("Unidade 1"), { target: { value: unitId } });
    fireEvent.change(screen.getByLabelText("Papel 1"), { target: { value: "ATTENDANT" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar convite" }));

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.queryByText(invitationToken)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Revelar" }));
    expect(screen.getByText(invitationToken)).toBeTruthy();
    expect(submitted?.providerCode).toBe("primary");
    expect(submitted?.assignments).toEqual([{ unitId, role: "ATTENDANT" }]);
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    fireEvent.click(screen.getByRole("button", { name: "Fechar e apagar token" }));
    expect(screen.queryByText(invitationToken)).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("never presents a token again for an idempotent replay", async () => {
    const client: InvitationClient = {
      async getUserInvitationOptions() { return options; },
      async createUserInvitation(input) { return {
        invitation: { id: "44444444-4444-4444-8444-444444444444", email: input.email,
          displayName: input.displayName, status: "PENDING", expiresAt: input.expiresAt,
          providerCode: input.providerCode }, assignments: [], replayed: true,
      }; },
    };
    render(<InvitationPanel client={client}/>);
    await screen.findByRole("option", { name: "primary" });
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Pessoa" } });
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "pessoa@example.test" } });
    fireEvent.change(screen.getByLabelText("Unidade 1"), { target: { value: unitId } });
    fireEvent.change(screen.getByLabelText("Papel 1"), { target: { value: "ATTENDANT" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar convite" }));
    expect(await screen.findByText(/token não pode ser exibido novamente/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copiar token" })).toBeNull();
  });

  it("does not submit duplicate unit assignments", async () => {
    const createUserInvitation = vi.fn();
    const client: InvitationClient = { async getUserInvitationOptions() { return {
      ...options, units: [...options.units, { id: "55555555-5555-4555-8555-555555555555", code: "SUL", name: "Sul" }],
    }; }, createUserInvitation };
    render(<InvitationPanel client={client}/>);
    await screen.findByRole("option", { name: "primary" });
    fireEvent.click(screen.getByRole("button", { name: "Adicionar unidade" }));
    fireEvent.change(screen.getByLabelText("Unidade 1"), { target: { value: unitId } });
    fireEvent.change(screen.getByLabelText("Unidade 2"), { target: { value: unitId } });
    expect(screen.getByText("Cada unidade pode aparecer somente uma vez.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Criar convite" }).hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(createUserInvitation).not.toHaveBeenCalled());
  });

  it("does not retry a failed mutation automatically", async () => {
    const createUserInvitation = vi.fn(async () => { throw new Error("network failure"); });
    const client: InvitationClient = {
      async getUserInvitationOptions() { return options; }, createUserInvitation,
    };
    render(<InvitationPanel client={client}/>);
    await screen.findByRole("option", { name: "primary" });
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Pessoa" } });
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "pessoa@example.test" } });
    fireEvent.change(screen.getByLabelText("Unidade 1"), { target: { value: unitId } });
    fireEvent.change(screen.getByLabelText("Papel 1"), { target: { value: "ATTENDANT" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar convite" }));
    expect(await screen.findByText("Não foi possível criar o convite.")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(createUserInvitation).toHaveBeenCalledTimes(1);
  });

  it("rejects an expired date before calling the API", async () => {
    const createUserInvitation = vi.fn();
    const client: InvitationClient = {
      async getUserInvitationOptions() { return options; }, createUserInvitation,
    };
    render(<InvitationPanel client={client}/>);
    await screen.findByRole("option", { name: "primary" });
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Pessoa" } });
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "pessoa@example.test" } });
    fireEvent.change(screen.getByLabelText("Unidade 1"), { target: { value: unitId } });
    fireEvent.change(screen.getByLabelText("Papel 1"), { target: { value: "ATTENDANT" } });
    fireEvent.change(screen.getByLabelText("Expira em"), { target: { value: "2020-01-01T12:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar convite" }));
    expect(await screen.findByText("Informe uma data futura válida para expiração.")).toBeTruthy();
    expect(createUserInvitation).not.toHaveBeenCalled();
  });
});
