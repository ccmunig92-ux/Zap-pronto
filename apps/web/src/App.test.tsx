// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApiProblem, AuthenticationRequired, InvalidApiResponse } from "@zap-pronto/api-client";
import { App } from "./App.js";

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
});
