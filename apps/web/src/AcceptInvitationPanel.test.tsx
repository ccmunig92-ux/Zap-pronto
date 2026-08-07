// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiProblem, AuthenticationRequired } from "@zap-pronto/api-client";
import type { CurrentUser } from "@zap-pronto/contracts";
import { AcceptInvitationPanel, type AcceptanceClient } from "./AcceptInvitationPanel.js";

const currentUser: CurrentUser = {
  user: { id: "22222222-2222-4222-8222-222222222222", email: "new@example.test", displayName: "Nova" },
  tenant: { id: "11111111-1111-4111-8111-111111111111", name: "Clínica" },
  memberships: [], grants: [],
};
const token = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";

afterEach(cleanup);
describe("OIDC invitation acceptance", () => {
  it("submits a transient token and promotes the server-derived current user", async () => {
    const accept = vi.fn<AcceptanceClient["acceptUserInvitation"]>(async () => ({ currentUser, replayed: false }));
    const onAccepted = vi.fn();
    render(<AcceptInvitationPanel client={{ acceptUserInvitation: accept }} onAccepted={onAccepted}/>);
    const input = screen.getByLabelText("Token do convite") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("off");
    fireEvent.change(input, { target: { value: token } });
    fireEvent.click(screen.getByRole("button", { name: "Aceitar convite" }));
    await screen.findByRole("button", { name: "Aceitar convite" });
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept.mock.calls[0]?.[0]).toBe(token);
    expect(accept.mock.calls[0]?.[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(onAccepted).toHaveBeenCalledWith(currentUser);
    expect(input.value).toBe("");
  });

  it("requires OIDC authentication without persisting or retrying the token", async () => {
    const accept = vi.fn<AcceptanceClient["acceptUserInvitation"]>(async () => {
      throw new AuthenticationRequired();
    });
    render(<AcceptInvitationPanel client={{ acceptUserInvitation: accept }} onAccepted={() => undefined}/>);
    fireEvent.change(screen.getByLabelText("Token do convite"), { target: { value: token } });
    fireEvent.click(screen.getByRole("button", { name: "Aceitar convite" }));
    expect(await screen.findByText("Entre com sua conta OIDC antes de aceitar o convite.")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed token before reaching the client", async () => {
    const accept = vi.fn<AcceptanceClient["acceptUserInvitation"]>();
    render(<AcceptInvitationPanel client={{ acceptUserInvitation: accept }} onAccepted={() => undefined}/>);
    const form = screen.getByLabelText("Token do convite").closest("form");
    fireEvent.change(screen.getByLabelText("Token do convite"), { target: { value: "invalid" } });
    fireEvent.submit(form!);
    expect(await screen.findByText("Informe um token de convite válido.")).toBeTruthy();
    expect(accept).not.toHaveBeenCalled();
  });

  it.each([[37, "37 segundos"], [120, "2 minutos"]] as const)(
    "shows retry-after %s on 429 without retrying automatically", async (retryAfter, delay) => {
    const accept = vi.fn<AcceptanceClient["acceptUserInvitation"]>(async () => {
      throw new ApiProblem({ type: "urn:test:rate-limit", title: "Too Many Requests", status: 429,
        correlationId: "correlation-429" }, retryAfter);
    });
    render(<AcceptInvitationPanel client={{ acceptUserInvitation: accept }} onAccepted={() => undefined}/>);
    const input = screen.getByLabelText("Token do convite") as HTMLInputElement;
    fireEvent.change(input, { target: { value: token } });
    fireEvent.click(screen.getByRole("button", { name: "Aceitar convite" }));
    expect(await screen.findByText(`Muitas tentativas. Tente novamente manualmente em ${delay}.`)).toBeTruthy();
    expect(screen.getByText("Correlação: correlation-429")).toBeTruthy();
    expect(input.value).toBe(token);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(accept).toHaveBeenCalledTimes(1);
  });
});
