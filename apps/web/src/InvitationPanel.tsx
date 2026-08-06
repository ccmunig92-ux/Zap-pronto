import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiProblem } from "@zap-pronto/api-client";
import type {
  CreateUserInvitationRequest,
  CreateUserInvitationResponse,
  InvitationRole,
  UserInvitationOptions,
} from "@zap-pronto/contracts";

export interface InvitationClient {
  getUserInvitationOptions(): Promise<UserInvitationOptions>;
  createUserInvitation(
    input: CreateUserInvitationRequest,
    idempotencyKey: string,
  ): Promise<CreateUserInvitationResponse>;
}

type Assignment = { unitId: string; role: InvitationRole | "" };

function defaultExpiry(): string {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

export function InvitationPanel({ client }: { readonly client: InvitationClient }) {
  const [options, setOptions] = useState<UserInvitationOptions>();
  const [loadError, setLoadError] = useState<string>();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [providerCode, setProviderCode] = useState("");
  const [expiresAt, setExpiresAt] = useState(defaultExpiry);
  const [assignments, setAssignments] = useState<Assignment[]>([{ unitId: "", role: "" }]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<{ message: string; correlationId?: string }>();
  const [idempotencyKey, setIdempotencyKey] = useState<string>();
  const [result, setResult] = useState<CreateUserInvitationResponse>();
  const [revealed, setRevealed] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string>();

  useEffect(() => {
    let active = true;
    client.getUserInvitationOptions().then((value) => {
      if (!active) return;
      setOptions(value);
      setProviderCode(value.providers[0]?.code ?? "");
    }).catch(() => { if (active) setLoadError("Não foi possível carregar as opções de convite."); });
    return () => { active = false; };
  }, [client]);

  const duplicateUnits = useMemo(() => {
    const selected = assignments.map(({ unitId }) => unitId).filter(Boolean);
    return new Set(selected).size !== selected.length;
  }, [assignments]);

  function changed(): void {
    setIdempotencyKey(undefined);
    setSubmitError(undefined);
  }

  function updateAssignment(index: number, value: Assignment): void {
    changed();
    setAssignments((current) => current.map((assignment, position) => position === index ? value : assignment));
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!options || duplicateUnits || assignments.some(({ unitId, role }) => !unitId || !role)) return;
    const expiry = new Date(expiresAt);
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) {
      setSubmitError({ message: "Informe uma data futura válida para expiração." });
      return;
    }
    const key = idempotencyKey ?? crypto.randomUUID();
    setIdempotencyKey(key);
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      const response = await client.createUserInvitation({
        email: email.trim(), displayName: displayName.trim(), providerCode,
        expiresAt: expiry.toISOString(),
        assignments: assignments.map(({ unitId, role }) => ({ unitId, role: role as InvitationRole })),
      }, key);
      setResult(response);
    } catch (error) {
      if (error instanceof ApiProblem) {
        setSubmitError({ message: error.problem.title, correlationId: error.problem.correlationId });
      } else {
        setSubmitError({ message: "Não foi possível criar o convite." });
      }
    } finally {
      setSubmitting(false);
    }
  }

  function closeDelivery(): void {
    setResult(undefined);
    setRevealed(false);
    setCopyStatus(undefined);
    setIdempotencyKey(undefined);
    setEmail("");
    setDisplayName("");
    setAssignments([{ unitId: "", role: "" }]);
  }

  if (loadError) return <section aria-labelledby="invitation-title"><h2 id="invitation-title">Convidar usuário</h2>
    <p role="alert">{loadError}</p></section>;
  if (!options) return <section aria-labelledby="invitation-title"><h2 id="invitation-title">Convidar usuário</h2>
    <p>Carregando opções…</p></section>;

  return <section aria-labelledby="invitation-title">
    <h2 id="invitation-title">Convidar usuário</h2>
    <form onSubmit={(event) => void submit(event)}>
      <label>Nome<input required maxLength={160} value={displayName} onChange={(event) => {
        changed(); setDisplayName(event.target.value);
      }}/></label>
      <label>E-mail<input required type="email" maxLength={320} value={email} onChange={(event) => {
        changed(); setEmail(event.target.value);
      }}/></label>
      <label>Provedor<select required value={providerCode} onChange={(event) => {
        changed(); setProviderCode(event.target.value);
      }}><option value="" disabled>Selecione</option>{options.providers.map(({ code }) =>
        <option key={code} value={code}>{code}</option>)}</select></label>
      <label>Expira em<input required type="datetime-local" value={expiresAt} onChange={(event) => {
        changed(); setExpiresAt(event.target.value);
      }}/></label>
      <fieldset><legend>Unidades e papéis</legend>{assignments.map((assignment, index) =>
        <div className="assignment" key={index}>
          <label>Unidade<select required aria-label={`Unidade ${index + 1}`} value={assignment.unitId}
            onChange={(event) => updateAssignment(index, { ...assignment, unitId: event.target.value })}>
            <option value="" disabled>Selecione</option>{options.units.map((unit) =>
              <option key={unit.id} value={unit.id}>{unit.name} ({unit.code})</option>)}</select></label>
          <label>Papel<select required aria-label={`Papel ${index + 1}`} value={assignment.role}
            onChange={(event) => updateAssignment(index, { ...assignment, role: event.target.value as InvitationRole })}>
            <option value="" disabled>Selecione</option>{options.roles.map((role) =>
              <option key={role} value={role}>{role}</option>)}</select></label>
          {assignments.length > 1 && <button type="button" onClick={() => {
            changed(); setAssignments((current) => current.filter((_, position) => position !== index));
          }}>Remover</button>}
        </div>)}</fieldset>
      {duplicateUnits && <p role="alert">Cada unidade pode aparecer somente uma vez.</p>}
      <button type="button" disabled={assignments.length >= Math.min(50, options.units.length)} onClick={() => {
        changed(); setAssignments((current) => [...current, { unitId: "", role: "" }]);
      }}>Adicionar unidade</button>
      <button type="submit" disabled={submitting || duplicateUnits || options.providers.length === 0
        || options.units.length === 0 || options.roles.length === 0}>{submitting ? "Criando…" : "Criar convite"}</button>
      {submitError && <p role="alert">{submitError.message}
        {submitError.correlationId && <small> Correlação: {submitError.correlationId}</small>}</p>}
    </form>
    {result && <div role="dialog" aria-modal="true" aria-labelledby="delivery-title" className="delivery-dialog">
      <h3 id="delivery-title">Entrega manual do convite</h3>
      <p>Convite para <strong>{result.invitation.email}</strong>.</p>
      {result.replayed ? <p role="alert">Este convite já existia. O token não pode ser exibido novamente.
        Revogue e emita outro convite se o token foi perdido.</p> : <>
        <p>Copie o token agora. Ele não será exibido novamente depois que esta janela for fechada.</p>
        <output aria-label="Token do convite">{revealed ? result.invitationToken : "••••••••••••••••"}</output>
        <button type="button" onClick={() => setRevealed((value) => !value)}>{revealed ? "Ocultar" : "Revelar"}</button>
        <button type="button" onClick={() => { void navigator.clipboard.writeText(result.invitationToken)
          .then(() => setCopyStatus("Token copiado."), () => setCopyStatus("Não foi possível copiar o token."));
        }}>Copiar token</button>{copyStatus && <p role="status">{copyStatus}</p>}
      </>}
      <button type="button" onClick={closeDelivery}>Fechar e apagar token</button>
    </div>}
  </section>;
}
