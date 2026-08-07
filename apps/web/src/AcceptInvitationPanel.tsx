import { useState, type FormEvent } from "react";
import { ApiProblem, AuthenticationRequired } from "@zap-pronto/api-client";
import type { AcceptUserInvitationResponse, CurrentUser } from "@zap-pronto/contracts";

export interface AcceptanceClient {
  acceptUserInvitation(invitationToken: string, idempotencyKey: string): Promise<AcceptUserInvitationResponse>;
}

function retryDelay(seconds: number): string {
  if (seconds < 60) return `${seconds} ${seconds === 1 ? "segundo" : "segundos"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} ${minutes === 1 ? "minuto" : "minutos"}`;
}

export function AcceptInvitationPanel({ client, onAccepted, onAuthenticationRequired = () => undefined }: {
  readonly client: AcceptanceClient; readonly onAccepted: (currentUser: CurrentUser) => void;
  readonly onAuthenticationRequired?: () => void;
}) {
  const [token, setToken] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; correlationId?: string }>();

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const normalized = token.trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(normalized)) {
      setError({ message: "Informe um token de convite válido." }); return;
    }
    const key = idempotencyKey ?? crypto.randomUUID();
    setIdempotencyKey(key); setSubmitting(true); setError(undefined);
    try {
      const response = await client.acceptUserInvitation(normalized, key);
      setToken(""); setIdempotencyKey(undefined); onAccepted(response.currentUser);
    } catch (cause) {
      if (cause instanceof AuthenticationRequired) {
        onAuthenticationRequired();
        setError({ message: "Entre com sua conta OIDC antes de aceitar o convite." });
      } else if (cause instanceof ApiProblem) {
        if (cause.problem.status === 429) {
          setError({ message: cause.retryAfterSeconds
            ? `Muitas tentativas. Tente novamente manualmente em ${retryDelay(cause.retryAfterSeconds)}.`
            : "Muitas tentativas. Aguarde antes de tentar novamente manualmente.",
          correlationId: cause.problem.correlationId });
        } else {
          setError({ message: cause.problem.title, correlationId: cause.problem.correlationId });
        }
      } else {
        setError({ message: "Não foi possível aceitar o convite." });
      }
    } finally { setSubmitting(false); }
  }

  return <section aria-labelledby="accept-invitation-title">
    <h2 id="accept-invitation-title">Aceitar convite</h2>
    <p>Depois de entrar com a conta convidada, digite o token recebido do administrador.</p>
    <form onSubmit={(event) => void submit(event)}>
      <label>Token do convite<input type="password" required minLength={43} maxLength={43}
        autoComplete="off" spellCheck={false} value={token} onChange={(event) => {
          setToken(event.target.value); setIdempotencyKey(undefined); setError(undefined);
        }}/></label>
      <button type="submit" disabled={submitting}>{submitting ? "Aceitando…" : "Aceitar convite"}</button>
      {error && <p role="alert">{error.message}{error.correlationId &&
        <small> Correlação: {error.correlationId}</small>}</p>}
    </form>
  </section>;
}
