// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiProblem, AuthenticationRequired } from "@zap-pronto/api-client";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function client(overrides: Partial<AdministrationClient> = {}): AdministrationClient {
  return {
    async listAdministrativeUsers() { return { items: [user] }; },
    async listAdministrativeInvitations() { return { items: [invitation] }; },
    async changeAdministrativeUserStatus() { return {}; },
    async changeUnitMembership() { return {}; },
    async revokeUserInvitation() { return {}; },
    async reissueUserInvitation() { return { invitation, replayed: true }; },
    ...overrides,
  };
}

afterEach(cleanup);
describe("administrative lifecycle", () => {
  it("blocks navigation while a lifecycle dialog is open and clears on unmount", async () => {
    const state = vi.fn();
    const view = render(<AdministrationPanel client={client()} onNavigationStateChange={state}/>);
    fireEvent.click(await screen.findByRole("button", { name: "Bloquear" }));
    expect(state).toHaveBeenLastCalledWith({ blocked: true, dirty: true });
    view.unmount();
    expect(state).toHaveBeenLastCalledWith({ blocked: false, dirty: false });
  });

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

  it("notifies the shell when the account is blocked or revoked during the session", async () => {
    const onAuthenticationRequired = vi.fn();
    render(<AdministrationPanel client={client({
      async listAdministrativeUsers() { throw new AuthenticationRequired(); },
    })} onAuthenticationRequired={onAuthenticationRequired}/>);
    await vi.waitFor(() => expect(onAuthenticationRequired).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Agente")).toBeNull();
  });

  it("refreshes grants after a 403 instead of retaining an administrative error state", async () => {
    const onAuthorizationChanged = vi.fn();
    const change = vi.fn<AdministrationClient["changeAdministrativeUserStatus"]>(async () => {
      throw new ApiProblem({ type: "urn:test:forbidden", title: "Forbidden", status: 403,
        correlationId: "correlation-403" });
    });
    render(<AdministrationPanel client={client({ changeAdministrativeUserStatus: change })}
      onAuthorizationChanged={onAuthorizationChanged}/>);
    await screen.findByText("Agente");
    fireEvent.click(screen.getByRole("button", { name: "Bloquear" }));
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "Permissão alterada" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar bloquear" }));
    await vi.waitFor(() => expect(onAuthorizationChanged).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Forbidden")).toBeNull();
  });
  it("revokes and reactivates memberships with expectedVersion and a stable retry key",async()=>{const active={unitId:"33333333-3333-4333-8333-333333333333",unitCode:"CENTRO",unitName:"Centro",role:"ATTENDANT"as const,status:"ACTIVE"as const,version:4,allowedActions:["REVOKE"as const]};const revoked={...active,unitId:"33333333-3333-4333-8333-333333333334",unitCode:"NORTE",unitName:"Norte",status:"REVOKED"as const,version:8,allowedActions:["REACTIVATE"as const]};const target={...user,memberships:[active,revoked]};const change=vi.fn<AdministrationClient["changeUnitMembership"]>().mockRejectedValueOnce(new Error("network")).mockResolvedValue({});
    render(<AdministrationPanel client={client({listAdministrativeUsers:async()=>({items:[target]}),changeUnitMembership:change})}/>);await screen.findByText(/Centro · ATTENDANT · Ativo/);fireEvent.click(screen.getByRole("button",{name:"Revogar vínculo"}));fireEvent.change(screen.getByLabelText("Motivo"),{target:{value:"Mudança de equipe"}});const confirm=screen.getByRole("button",{name:"Confirmar revogar vínculo"});fireEvent.click(confirm);fireEvent.click(confirm);await vi.waitFor(()=>expect(change).toHaveBeenCalledTimes(1));await screen.findByText("Não foi possível concluir a ação.");fireEvent.click(confirm);await vi.waitFor(()=>expect(change).toHaveBeenCalledTimes(2));expect(change.mock.calls[0]?.[1]).toBe(active.unitId);expect(change.mock.calls[0]?.[2]).toEqual({operation:"REVOKE",expectedVersion:4,reason:"Mudança de equipe"});expect(change.mock.calls[0]?.[3]).toBe(change.mock.calls[1]?.[3]);});
  it("renders a revoked membership only with the server-derived reactivate action",async()=>{const membership={unitId:"33333333-3333-4333-8333-333333333334",unitCode:"NORTE",unitName:"Norte",role:"SUPERVISOR"as const,status:"REVOKED"as const,version:8,allowedActions:["REACTIVATE"as const]};render(<AdministrationPanel client={client({listAdministrativeUsers:async()=>({items:[{...user,memberships:[membership]}]})})}/>);expect(await screen.findByText(/Norte · SUPERVISOR · Revogado/)).toBeTruthy();expect(screen.getByRole("button",{name:"Reativar vínculo"})).toBeTruthy();expect(screen.queryByRole("button",{name:"Revogar vínculo"})).toBeNull();});

  it("submits REACTIVATE with the membership version and reuses its key after retry", async () => {
    const membership = { unitId: "33333333-3333-4333-8333-333333333334", unitCode: "NORTE",
      unitName: "Norte", role: "SUPERVISOR" as const, status: "REVOKED" as const, version: 8,
      allowedActions: ["REACTIVATE" as const] };
    const change = vi.fn<AdministrationClient["changeUnitMembership"]>()
      .mockRejectedValueOnce(new Error("network")).mockResolvedValue({});
    render(<AdministrationPanel client={client({
      async listAdministrativeUsers() { return { items: [{ ...user, memberships: [membership] }] }; },
      changeUnitMembership: change,
    })}/>);
    await screen.findByText(/Norte · SUPERVISOR · Revogado/);
    fireEvent.click(screen.getByRole("button", { name: "Reativar vínculo" }));
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "Retorno à unidade" } });
    const confirm = screen.getByRole("button", { name: "Confirmar reativar vínculo" });
    fireEvent.click(confirm);
    await screen.findByText("Não foi possível concluir a ação.");
    fireEvent.click(confirm);
    await vi.waitFor(() => expect(change).toHaveBeenCalledTimes(2));
    expect(change.mock.calls[0]?.slice(0, 3)).toEqual([user.id, membership.unitId,
      { operation: "REACTIVATE", expectedVersion: 8, reason: "Retorno à unidade" }]);
    expect(change.mock.calls[0]?.[3]).toMatch(/^[0-9a-f-]{36}$/);
    expect(change.mock.calls[1]?.[3]).toBe(change.mock.calls[0]?.[3]);
  });

  it.each([
    [404, "O vínculo não está mais disponível."],
    [409, "Os dados foram alterados. Atualize e tente novamente."],
  ])("sanitizes a %i mutation response", async (status, expectedMessage) => {
    const change = vi.fn<AdministrationClient["changeAdministrativeUserStatus"]>(async () => {
      throw new ApiProblem({ type: "urn:internal", title: "SQL membership secret", status,
        detail: "users_internal row leaked", correlationId: `correlation-${status}` });
    });
    render(<AdministrationPanel client={client({ changeAdministrativeUserStatus: change })}/>);
    await screen.findByText("Agente");
    fireEvent.click(screen.getByRole("button", { name: "Bloquear" }));
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "Ação administrativa" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar bloquear" }));
    expect(await screen.findByText(new RegExp(expectedMessage))).toBeTruthy();
    expect(screen.queryByText(/SQL membership secret|users_internal row leaked/)).toBeNull();
    expect(screen.getByText(new RegExp(`correlation-${status}`))).toBeTruthy();
  });

  it("preserves already loaded users when loading another page fails", async () => {
    const list = vi.fn<AdministrationClient["listAdministrativeUsers"]>(async (input = {}) => {
      if (input.cursor) throw new Error("network");
      return { items: [user], nextCursor: "next-page" };
    });
    render(<AdministrationPanel client={client({ listAdministrativeUsers: list })}/>);
    await screen.findByText("Agente");
    fireEvent.click(screen.getByRole("button", { name: "Carregar mais usuários" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Não foi possível carregar mais usuários.");
    expect(screen.getByText("Agente")).toBeTruthy();
  });

  it("ignores a late page response after an authorization purge advances the generation", async () => {
    const latePage = deferred<{ items: AdministrativeUser[] }>();
    const second = { ...user, id: "55555555-5555-4555-8555-555555555555", displayName: "Segundo" };
    const list = vi.fn<AdministrationClient["listAdministrativeUsers"]>((input = {}) =>
      input.cursor ? latePage.promise : Promise.resolve({ items: [user], nextCursor: "next-page" }));
    const change = vi.fn<AdministrationClient["changeAdministrativeUserStatus"]>(async () => {
      throw new ApiProblem({ type: "urn:test:forbidden", title: "Forbidden", status: 403,correlationId:"corr-stale" });
    });
    const onAuthorizationChanged = vi.fn();
    render(<AdministrationPanel client={client({ listAdministrativeUsers: list,
      changeAdministrativeUserStatus: change })} onAuthorizationChanged={onAuthorizationChanged}/>);
    await screen.findByText("Agente");
    fireEvent.click(screen.getByRole("button", { name: "Carregar mais usuários" }));
    fireEvent.click(screen.getByRole("button", { name: "Bloquear" }));
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "Permissão removida" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar bloquear" }));
    await vi.waitFor(() => expect(onAuthorizationChanged).toHaveBeenCalledTimes(1));
    latePage.resolve({ items: [second] });
    await vi.waitFor(() => expect(screen.queryByText("Segundo")).toBeNull());
    expect(screen.queryByText("Agente")).toBeNull();
  });

  it.each([401, 403])("purges users, invitations and an open dialog after a %i", async (status) => {
    const callback = vi.fn();
    const change = vi.fn<AdministrationClient["changeAdministrativeUserStatus"]>(async () => {
      throw new ApiProblem({ type: "urn:test:access-changed", title: "Access changed", status,correlationId:`corr-${status}` });
    });
    render(<AdministrationPanel client={client({ changeAdministrativeUserStatus: change })}
      {...(status===401?{onAuthenticationRequired:callback}:{onAuthorizationChanged:callback})}/>);
    await screen.findByText("Agente");
    expect(screen.getByText("Nova pessoa")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Bloquear" }));
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "Acesso alterado" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar bloquear" }));
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Agente")).toBeNull();
    expect(screen.queryByText("Nova pessoa")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Access changed")).toBeNull();
  });
});
