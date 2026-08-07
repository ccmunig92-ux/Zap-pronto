// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiProblem, AuthenticationRequired, InvalidApiResponse } from "@zap-pronto/api-client";
import { App } from "./App.js";
import type { AdministrationClient } from "./AdministrationPanel.js";

afterEach(cleanup);
describe("authenticated shell", () => {
  it("renders the server-derived tenant and active memberships", async () => {
    render(<App client={{ async getCurrentUser() { return {
      user: { id: "22222222-2222-4222-8222-222222222222", email: "agent@example.test", displayName: "Agente" },
      tenant: { id: "11111111-1111-4111-8111-111111111111", name: "Clínica" },
      memberships: [{ unitId: "33333333-3333-4333-8333-333333333333", unitCode: "CENTRO",
        unitName: "Centro", role: "ATTENDANT" }], grants: [],
    }; } }} />);
    expect(await screen.findByText("Clínica")).toBeTruthy();
    expect(screen.getByText("Centro")).toBeTruthy();
  });
  it("shows sign-in when no access token is available", async () => {
    render(<App client={{ async getCurrentUser() { throw new AuthenticationRequired(); } }} />);
    const button = await screen.findByRole("button", { name: "Entrar" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("OIDC não configurado neste ambiente.")).toBeTruthy();
  });
  it.each([[403, "Forbidden"], [503, "Service Unavailable"]])(
    "shows API problem %s and its correlation id", async (status, title) => {
      render(<App client={{ async getCurrentUser() { throw new ApiProblem({
        type: "urn:test", title, status, correlationId: "correlation-123",
      }); } }} />);
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.getByText("Correlação: correlation-123")).toBeTruthy();
    },
  );
  it("sanitizes an invalid transport response", async () => {
    render(<App client={{ async getCurrentUser() { throw new InvalidApiResponse(); } }} />);
    expect(await screen.findByText("Não foi possível carregar a sessão.")).toBeTruthy();
  });
  it("removes administrative state after a 403 and reloads grants from the server", async () => {
    const base = {
      user: { id: "22222222-2222-4222-8222-222222222222", email: "admin@example.test", displayName: "Admin" },
      tenant: { id: "11111111-1111-4111-8111-111111111111", name: "Clínica" },
      memberships: [],
    } as const;
    const getCurrentUser = vi.fn()
      .mockResolvedValueOnce({ ...base, grants: [{ permission: "tenant.users.manage" as const, scope: "TENANT" as const }] })
      .mockResolvedValueOnce({ ...base, grants: [] });
    const administrationClient: AdministrationClient = {
      async listAdministrativeUsers() { return { items: [{ id: base.user.id, email: base.user.email,
        displayName: base.user.displayName, status: "ACTIVE", version: 1, memberships: [], allowedActions: ["BLOCK"] }] }; },
      async listAdministrativeInvitations() { return { items: [] }; },
      async changeAdministrativeUserStatus() { throw new ApiProblem({ type: "urn:test", title: "Forbidden",
        status: 403, correlationId: "correlation-403" }); },
      async revokeUserInvitation() { return {}; },
      async reissueUserInvitation() { throw new Error("not called"); },
    };
    render(<App client={{ getCurrentUser }} administrationClient={administrationClient}
      invitationClient={{ async getUserInvitationOptions() { return { providers: [], units: [], roles: [] }; },
        async createUserInvitation() { throw new Error("not called"); } }}/>);
    fireEvent.click(await screen.findByRole("button", { name: "Bloquear" }));
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "Permissão revogada" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar bloquear" }));
    await waitFor(() => expect(getCurrentUser).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Administração de acesso")).toBeNull());
    expect(screen.getByText("Clínica")).toBeTruthy();
  });
});
